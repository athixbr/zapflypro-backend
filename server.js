const crypto = require('crypto');
global.crypto = crypto;

const express = require('express');
const app = express(); 
const multer = require('multer');

const http = require('http').createServer(app); 
const P = require('pino');
const mysql = require('mysql2/promise');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrImage = require('qr-image');
const { join } = require('path');
const fs = require('fs');
const cors = require('cors');

const processQueue = async () => {
  while (true) {
    try {
      const rawMessage = await redis.rpop('message_queue');

      if (!rawMessage) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      const msg = JSON.parse(rawMessage);
      const { userId, groupId, caption, column, scheduledTime } = msg;

      // Fallback para recuperar o filePath correto
      const finalFilePath = msg.filePath || msg.image_url || msg.video_url || msg.document_url || msg.audio_url;
      const finalColumn = column || (msg.image_url ? 'image_url'
                                    : msg.video_url ? 'video_url'
                                    : msg.document_url ? 'document_url'
                                    : msg.audio_url ? 'audio_url'
                                    : null);

      if (!userId || !groupId || !finalFilePath || !finalColumn) {
        console.error(`❌ Parâmetros ausentes ou inválidos: ${JSON.stringify(msg)}`);
        continue;
      }

      // Montar payload de envio com base na mídia
      let payload;
      if (finalColumn === 'image_url') {
        payload = { image: { url: finalFilePath }, caption, jpegThumbnail: Buffer.alloc(0) };
      } else if (finalColumn === 'video_url') {
        payload = { video: { url: finalFilePath }, caption };
      } else if (finalColumn === 'audio_url') {
        payload = { audio: { url: finalFilePath }, caption };
      } else {
        payload = { document: { url: finalFilePath }, caption };
      }

      try {
        await sock.sendMessage(groupId, payload);
        console.log(`✅ Mensagem enviada para grupo ${groupId}`);

        const connection = await dbPool.getConnection();
        await connection.execute(
          'UPDATE messages_queue SET status = ?, error = NULL WHERE user_id = ? AND group_id = ? AND (image_url = ? OR video_url = ? OR audio_url = ? OR document_url = ?)',
          ['sent', userId, groupId, msg.image_url, msg.video_url, msg.audio_url, msg.document_url]
        );
        connection.release();

      } catch (sendError) {
        console.error(`❌ Erro ao enviar para grupo ${groupId}: ${sendError.message}`);

        if (sendError.message.includes('Connection Closed') || sendError.message.includes('Timed Out')) {
          console.log('🔁 Tentando reconectar e reenviar...');
          await connectToWhatsApp();
          await new Promise(r => setTimeout(r, 10000));

          try {
            await sock.sendMessage(groupId, payload);
            console.log(`✅ Reenvio bem-sucedido após reconexão para ${groupId}`);
          } catch (finalError) {
            console.error(`❌ Falha após reconexão: ${finalError.message}`);
          }
        }

        const connection = await dbPool.getConnection();
        await connection.execute(
          'UPDATE messages_queue SET status = ?, error = ? WHERE user_id = ? AND group_id = ? AND (image_url = ? OR video_url = ? OR audio_url = ? OR document_url = ?)',
          [
            'failed',
            sendError.message ?? 'Erro desconhecido',
            userId ?? null,
            groupId ?? null,
            msg.image_url ?? null,
            msg.video_url ?? null,
            msg.audio_url ?? null,
            msg.document_url ?? null
          ]
        );

        connection.release();
      }

      // Delay entre cada mensagem (AUMENTADO para mais de 2 minutos)
      await new Promise(resolve => setTimeout(resolve, 130000)); // 130000 ms = 2 minutos e 10 segundos

    } catch (err) {
      console.error('❌ Erro inesperado na fila:', err);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
};

// Configuração do storage do multer para salvar arquivos em /uploads/files
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/files');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ storage: storage });


const io = require('socket.io')(http, {
    cors: {
        origin: '*',
    }
});

const wsMensagensController = require('./controllers/wsMensagensController');
const wsContatosController = require('./controllers/wsContatosController');


wsMensagensController.initWebSocket(io);
wsContatosController.initWebSocketContato(io);

// Disponibiliza globalmente, caso precise usar no futuro
global.wsBroadcastGrupo = wsMensagensController.emitirMensagemGrupo;
global.wsBroadcastContato = wsContatosController.emitirMensagemContato;


const SECRET_KEY = 'your-secret-key';




let dbPool;
async function connectToDatabase() {
    dbPool = await mysql.createPool({
        host: 'vps.iryd.com.br',
        user: 'zapfly-dev',
        password: 'drpLeyHPitikZ267',
        database: 'zapfly-dev',
        charset: 'utf8mb4', 
        waitForConnections: true,
        connectionLimit: 500,
        queueLimit: 0
    });
}
connectToDatabase();

async function safeQuery(query, params = []) {
    let connection;
    try {
        connection = await dbPool.getConnection();
        const [results] = await connection.execute(query, params);
        return results;
    } catch (error) {
        console.error('Erro ao executar query:', error);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}


let sock = null;

let authState = null;
let saveCreds = null;

async function init() {
    const authInfo = await useMultiFileAuthState('auth_info_baileys');
    authState = authInfo.state;
    saveCreds = authInfo.saveCreds;

    async function connectToWhatsApp() {
        if (sock) {
            try {
                await sock.logout();
            } catch (err) {
                console.log('Error logging out:', err);
            }
        }


sock = makeWASocket({
    auth: authState,
    printQRInTerminal: true,
    syncFullHistory: true,
    logger: P({ level: 'silent' }),
    shouldIgnoreJid: jid => {
        if (!jid || typeof jid !== 'string') return true;
        return jid.startsWith('status@broadcast') || jid.includes('spam');
    },
    patchMessageBeforeSending: (message) => {
        const requiresPatch = !!(
            message.buttonsMessage ||
            message.templateMessage ||
            message.listMessage
        );
        if (requiresPatch) {
            message = {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadataVersion: 2,
                            deviceListMetadata: {}
                        },
                        ...message,
                    },
                },
            };
        }
        return message;
    }
});



sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
        console.log('📱 QR Code recebido. Gerando imagem...');
        const qrCodeImage = qrImage.imageSync(qr, { type: 'png' });
        const qrPath = path.join(__dirname, 'qr-code.png');
        fs.writeFileSync(qrPath, qrCodeImage);
        console.log('✅ QR Code salvo em:', qrPath);
    }

    switch (connection) {
        case 'open':
            isWhatsAppConnected = true;
            console.log('✅ Conectado com sucesso ao WhatsApp');
            break;

        case 'close':
            isWhatsAppConnected = false;

            const isLoggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
            const shouldReconnect = !isLoggedOut;

            console.warn(`⚠️ Conexão com o WhatsApp fechada. Reconnect? ${shouldReconnect}`);

            if (shouldReconnect) {
                console.log('⏳ Aguardando 10 segundos antes de tentar reconectar...');
                setTimeout(async () => {
                    try {
                        await connectToWhatsApp();
                        console.log('🔄 Tentativa de reconexão realizada');
                    } catch (err) {
                        console.error('❌ Falha ao tentar reconectar:', err.message);
                    }
                }, 10000);
            } else {
                console.log('🛑 Sessão encerrada (logout). Apague a pasta auth_info_baileys para reconectar.');
            }
            break;

        default:
            console.log(`ℹ️ Estado da conexão: ${connection}`);
    }
});







sock.ev.on('creds.update', saveCreds);

let sessionWasOpen = false;




        sock.ev.on('connection.error', async (error) => {
            console.log('Connection error', error);
            console.log('Reconnecting...');
            await connectToWhatsApp();
        });
sock.ev.on('messages.upsert', async (msg) => {
    console.log('📥 Nova mensagem recebida:', msg.type);

    const { messages } = msg;

    for (let message of messages) {
        if (!message.message) {
            console.warn('⚠️ Mensagem ignorada: conteúdo criptografado ou sessão ausente');
            continue;
        }

        try {
            const groupId = message.key?.remoteJid || null;
            const senderId = message.key?.participant || null;

            if (!groupId || !groupId.endsWith('@g.us')) {
                console.log('📭 Ignorado: mensagem não é de grupo.');
                continue;
            }

            try {
                await getGroupMetadataSafe(groupId);
                console.log(`🔁 Metadados sincronizados (com cache) para o grupo ${groupId}`);
            } catch (metaErr) {
                console.warn(`⚠️ Falha ao sincronizar grupo ${groupId}: ${metaErr.message}`);
            }

            const conversation = message.message?.conversation || '';
            const extendedText = message.message?.extendedTextMessage?.text || '';
            const imageMessage = message.message?.imageMessage || null;
            const videoMessage = message.message?.videoMessage || null;
            const documentMessage = message.message?.documentMessage || null;
            const audioMessage = message.message?.audioMessage || null;

            const timestamp = Number(message.messageTimestamp) || null;
            const profilePictureUrl = ''; // Pode ser preenchido com await sock.profilePictureUrl(senderId)
            const text = conversation || extendedText || null;

            const truncateUrl = (url) => url?.length > 2048 ? url.substring(0, 2048) : url;

            const imageUrl = truncateUrl(imageMessage?.url) || null;
            const videoUrl = truncateUrl(videoMessage?.url) || null;
            const documentUrl = truncateUrl(documentMessage?.url) || null;
            const audioUrl = truncateUrl(audioMessage?.url) || null;

            const connection = await dbPool.getConnection();
            await connection.execute(
                'INSERT INTO messages1 (group_id, sender_id, message, image_url, video_url, document_url, audio_url, timestamp, profile_picture_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    groupId, senderId, text,
                    imageUrl, videoUrl, documentUrl, audioUrl,
                    timestamp, profilePictureUrl
                ]
            );
            connection.release();

            console.log(`✅ Mensagem salva com sucesso no grupo ${groupId}`);

            broadcastLiveMessage({
                groupId,
                senderId,
                text,
                imageUrl,
                videoUrl,
                documentUrl,
                audioUrl,
                timestamp,
                profile_picture_url: profilePictureUrl
            });

            global.broadcastLiveMessage = broadcastLiveMessage;

        } catch (error) {
            console.error('❌ Erro ao processar mensagem:', error.message);
        }
    }
});



    }

    await connectToWhatsApp();
        
        
        const reprocessAllFailedMessages = async () => {
    try {
        const failedMessages = await safeQuery(
            `SELECT * FROM messages_queue WHERE status = 'failed' ORDER BY id DESC LIMIT 1000`
        );

        let count = 0;

        for (let msg of failedMessages) {
            const payload = {
                userId: msg.user_id,
                groupId: msg.group_id,
                filePath: msg.file_path,
                caption: msg.caption,
                column: msg.image_url ? 'image_url' : msg.video_url ? 'video_url' : 'file_path',
                status: msg.status,
                scheduledTime: msg.scheduled_time
            };

            await redis.lpush('message_queue', JSON.stringify(payload));
            count++;
        }

        console.log(`♻️ ${count} mensagens com erro reprocessadas automaticamente após startup`);
    } catch (error) {
        console.error('❌ Erro ao reprocessar mensagens failed ao iniciar:', error);
    }
};

        
const reprocessFailedMessages = async () => {
    try {
        const failedMessages = await safeQuery(
            `SELECT * FROM messages_queue WHERE status = 'failed' AND created_at >= NOW() - INTERVAL 30 MINUTE LIMIT 50`
        );

        for (let message of failedMessages) {
            await redis.lpush('message_queue', JSON.stringify(message));
            console.log(`Mensagem ${message.id} reenviada para a fila.`);
        }
    } catch (error) {
        console.error('Erro ao reprocessar mensagens falhadas:', error);
    }
};



// Chamar essa função periodicamente
setInterval(reprocessFailedMessages, 300000); // Reprocessa a cada 5 minutos

        


const sendBatchMessages = async (messages) => {
    const delay = 2000;

    for (let msg of messages) {
        try {
            if (!fs.existsSync(msg.filePath)) {
                console.error(`Arquivo não encontrado: ${msg.filePath}`);
                await dbPool.execute('UPDATE messages_queue SET status = ?, error = ? WHERE id = ?',
                    ['failed', 'Arquivo não encontrado', msg.id]);
                continue;
            }

            await sock.sendMessage(msg.groupId, { image: { url: msg.filePath }, caption: msg.caption });
            console.log(`Mensagem enviada para ${msg.groupId}`);

            // Libera memória após envio
            if (global.gc) global.gc();

            await new Promise(resolve => setTimeout(resolve, delay));
        } catch (error) {
            console.error(`Erro ao enviar mensagem:`, error.message);
            await dbPool.execute(
                'UPDATE messages_queue SET status = ?, error = ? WHERE id = ?',
                ['failed', error.message, msg.id]
            );
        }
    }
};





const processQueue = async () => {
  while (true) {
    try {
      const rawMessage = await redis.rpop('message_queue');

      if (!rawMessage) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      const msg = JSON.parse(rawMessage);
      const { userId, groupId, caption, column, scheduledTime } = msg;

      // Fallback para recuperar o filePath correto
      const finalFilePath = msg.filePath || msg.image_url || msg.video_url || msg.document_url || msg.audio_url;
      const finalColumn = column || (msg.image_url ? 'image_url'
                                : msg.video_url ? 'video_url'
                                : msg.document_url ? 'document_url'
                                : msg.audio_url ? 'audio_url'
                                : null);

      if (!userId || !groupId || !finalFilePath || !finalColumn) {
        console.error(`❌ Parâmetros ausentes ou inválidos: ${JSON.stringify(msg)}`);
        continue;
      }

      // Montar payload de envio com base na mídia
      let payload;
      if (finalColumn === 'image_url') {
        payload = { image: { url: finalFilePath }, caption, jpegThumbnail: Buffer.alloc(0) };
      } else if (finalColumn === 'video_url') {
        payload = { video: { url: finalFilePath }, caption };
      } else if (finalColumn === 'audio_url') {
        payload = { audio: { url: finalFilePath }, caption };
      } else {
        payload = { document: { url: finalFilePath }, caption };
      }

      try {
        await sock.sendMessage(groupId, payload);
        console.log(`✅ Mensagem enviada para grupo ${groupId}`);

        const connection = await dbPool.getConnection();
        await connection.execute(
          'UPDATE messages_queue SET status = ?, error = NULL WHERE user_id = ? AND group_id = ? AND (image_url = ? OR video_url = ? OR audio_url = ? OR document_url = ?)',
          ['sent', userId, groupId, msg.image_url, msg.video_url, msg.audio_url, msg.document_url]
        );
        connection.release();

      } catch (sendError) {
        console.error(`❌ Erro ao enviar para grupo ${groupId}: ${sendError.message}`);

        if (sendError.message.includes('Connection Closed') || sendError.message.includes('Timed Out')) {
          console.log('🔁 Tentando reconectar e reenviar...');
          await connectToWhatsApp();
          await new Promise(r => setTimeout(r, 10000));

          try {
            await sock.sendMessage(groupId, payload);
            console.log(`✅ Reenvio bem-sucedido após reconexão para ${groupId}`);
          } catch (finalError) {
            console.error(`❌ Falha após reconexão: ${finalError.message}`);
          }
        }

        const connection = await dbPool.getConnection();
       await connection.execute(
  'UPDATE messages_queue SET status = ?, error = ? WHERE user_id = ? AND group_id = ? AND (image_url = ? OR video_url = ? OR audio_url = ? OR document_url = ?)',
  [
    'failed',
    sendError.message ?? 'Erro desconhecido',
    userId ?? null,
    groupId ?? null,
    msg.image_url ?? null,
    msg.video_url ?? null,
    msg.audio_url ?? null,
    msg.document_url ?? null
  ]
);

        connection.release();
      }

    } catch (err) {
      console.error('❌ Erro inesperado na fila:', err);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
};







processQueue();


   const processMessages = async () => {
    try {
        const connection = await dbPool.getConnection();
        console.log('Conexão com o banco de dados estabelecida');

        // Seleciona mensagens com status 'scheduled' e verifica se é hora de mudar para 'pending'
        const [scheduledRows] = await connection.execute('SELECT * FROM messages_queue WHERE status = ? AND scheduled_time <= NOW()', ['scheduled']);
        console.log(`Mensagens agendadas encontradas: ${scheduledRows.length}`);

        for (let message of scheduledRows) {
            await connection.execute('UPDATE messages_queue SET status = ? WHERE id = ?', ['pending', message.id]);
            console.log(`Mensagem ID ${message.id} mudada para 'pending'`);
        }

        // Processa as mensagens pendentes
        const [rows] = await connection.execute('SELECT * FROM messages_queue WHERE status = ? LIMIT 500', ['pending']);
        connection.release();
        console.log(`Mensagens pendentes encontradas: ${rows.length}`);

        for (let message of rows) {
            try {
                console.log(`Processando mensagem ID: ${message.id}, Group ID: ${message.group_id}`);
await getGroupMetadataSafe(message.group_id);
                console.log(`Metadata do grupo obtida para o Group ID: ${message.group_id}`);

                await sock.sendMessage(message.group_id, { image: { url: message.image_url }, caption: message.caption });
                console.log(`Mensagem enviada para o grupo: ${message.group_id}`);

                const connection = await dbPool.getConnection();
                await connection.execute('UPDATE messages_queue SET status = ? WHERE id = ?', ['sent', message.id]);
                connection.release();
                console.log(`Status da mensagem ID ${message.id} atualizado para 'sent'`);
            } catch (error) {
                console.error(`Erro ao enviar mensagem para o grupo ${message.group_id}:`, error);

                const connection = await dbPool.getConnection();
                await connection.execute('UPDATE messages_queue SET status = ?, error = ? WHERE id = ?', ['failed', error.message, message.id]);
                connection.release();
                console.log(`Status da mensagem ID ${message.id} atualizado para 'failed' com erro: ${error.message}`);
            }
        }
    } catch (error) {
        console.error('Erro ao processar mensagens:', error);
    }
};

setInterval(processMessages, 60000); // Verifica a fila a cada 60 segundos






    function verifyJWT(req, res, next) {
        const token = req.headers['x-access-token'];
        if (!token) {
            return res.status(403).send('Token is required');
        }

        jwt.verify(token, SECRET_KEY, (err, decoded) => {
            if (err) {
                return res.status(401).send('Unauthorized');
            }
            req.userId = decoded.id;
            next();
        });
    }

app.get('/reprocess-connection-closed-stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const failedMessages = await safeQuery(
        `SELECT * FROM messages_queue WHERE status = 'failed' AND error LIKE '%Connection Closed%' ORDER BY id DESC LIMIT 2500`
    );

    if (!failedMessages.length) {
        res.write('data: Nenhuma mensagem com erro "Connection Closed" encontrada.\n\n');
        res.end();
        return;
    }

    res.write(`data: 🔁 Iniciando reprocessamento de ${failedMessages.length} mensagens...\n\n`);

    let index = 0;

    const interval = setInterval(async () => {
        if (index >= failedMessages.length) {
            clearInterval(interval);
            res.write(`data: ✅ Fim do reprocessamento.\n\n`);
            res.end();
            return;
        }

        const msg = failedMessages[index++];
        const groupId = msg.group_id;
        const caption = msg.caption;
        let filePath = msg.file_path;
        let column = 'file_path';

        if (msg.image_url) {
            filePath = msg.image_url;
            column = 'image_url';
        } else if (msg.video_url) {
            filePath = msg.video_url;
            column = 'video_url';
        }

        if (!filePath || !groupId) {
            res.write(`data: ⚠️ Ignorando ID ${msg.id} (sem caminho ou grupo)\n\n`);
            return;
        }

        let payload;
        if (column === 'image_url') {
            payload = { image: { url: filePath }, caption };
        } else if (column === 'video_url') {
            payload = { video: { url: filePath }, caption };
        } else {
            payload = { document: { url: filePath }, caption };
        }

        try {
            await sock.sendMessage(groupId, payload);
            const conn = await dbPool.getConnection();
            await conn.execute('UPDATE messages_queue SET status = ?, error = NULL WHERE id = ?', ['sent', msg.id]);
            conn.release();

            res.write(`data: ✅ Mensagem ID ${msg.id} enviada com sucesso para grupo ${groupId}\n\n`);
        } catch (err) {
            const conn = await dbPool.getConnection();
            await conn.execute('UPDATE messages_queue SET status = ?, error = ? WHERE id = ?', ['failed', err.message, msg.id]);
            conn.release();

            res.write(`data: ❌ Erro ao reenviar ID ${msg.id}: ${err.message}\n\n`);
        }
    }, 300000); // ⏱ 5 minutos entre mensagens
});

app.post('/reprocess-connection-closed', async (req, res) => {
    try {
        const failedMessages = await safeQuery(
            `SELECT * FROM messages_queue WHERE status = 'failed' AND error LIKE '%Connection Closed%' ORDER BY id DESC LIMIT 2500`
        );

        if (!failedMessages.length) {
            return res.json({ status: 'ok', mensagem: 'Nenhuma mensagem com erro Connection Closed encontrada.' });
        }

        res.json({ status: 'iniciado', total: failedMessages.length });

        console.log(`🔁 Iniciando reprocessamento sequencial de ${failedMessages.length} mensagens...`);

        let index = 0;

        const interval = setInterval(async () => {
            if (index >= failedMessages.length) {
                clearInterval(interval);
                console.log('✅ Reprocessamento sequencial concluído.');
                return;
            }

            const msg = failedMessages[index++];
            const groupId = msg.group_id;
            const caption = msg.caption;
            const userId = msg.user_id;

            let filePath = msg.file_path || msg.image_url || msg.video_url || msg.document_url || msg.audio_url;
            let column = msg.image_url ? 'image_url' :
                         msg.video_url ? 'video_url' :
                         msg.document_url ? 'document_url' :
                         msg.audio_url ? 'audio_url' : null;

            if (!filePath || !groupId || !column) {
                console.warn(`⚠️ Ignorando mensagem ID ${msg.id}: dados ausentes`);
                return;
            }

            const payload = {
                userId,
                groupId,
                filePath,
                caption,
                column,
                status: msg.status,
                scheduledTime: msg.scheduled_time
            };

            try {
                await redis.lpush('message_queue', JSON.stringify(payload));
                console.log(`📤 Mensagem ID ${msg.id} reenfileirada com sucesso (grupo ${groupId})`);
            } catch (err) {
                console.error(`❌ Falha ao reenfileirar mensagem ID ${msg.id}: ${err.message}`);
            }
        }, 60000); // ⏱ 60 segundos entre cada mensagem
    } catch (err) {
        console.error('❌ Erro no reprocessamento:', err);
        res.status(500).send('Erro ao reprocessar mensagens');
    }
});


app.get('/all-group-messages', verifyJWT, async (req, res) => {
    try {
        const connection = await dbPool.getConnection();

        const [rows] = await connection.execute(`
            SELECT 
                id,
                group_id,
                sender_id,
                message,
                image_url,
                video_url,
                document_url,
                audio_url,
                timestamp,
                profile_picture_url
            FROM messages1
            ORDER BY timestamp DESC
            LIMIT 1000
        `);

        connection.release();

        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar todas as mensagens dos grupos:', error);
        res.status(500).send('Erro interno ao buscar mensagens');
    }
});

app.get('/health', async (req, res) => {
    const status = {
        redis: false,
        mysql: false,
        whatsapp: false,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    };

    try {
        // Testar Redis
        const pong = await redis.ping();
        if (pong === 'PONG') status.redis = true;
    } catch (err) {
        console.error('Redis falhou:', err.message);
    }

    try {
        // Testar MySQL
        const connection = await dbPool.getConnection();
        await connection.ping();
        connection.release();
        status.mysql = true;
    } catch (err) {
        console.error('MySQL falhou:', err.message);
    }

    try {
        // Testar conexão com o WhatsApp
        status.whatsapp = sock && sock.ws && sock.ws.readyState === 1;
    } catch (err) {
        console.error('Erro ao verificar WhatsApp:', err.message);
    }

    const allOk = status.redis && status.mysql && status.whatsapp;
    res.status(allOk ? 200 : 500).json(status);
});







app.post('/library/upload', verifyJWT, upload.array('files'), async (req, res) => {
  const userId = req.userId;
  const { caption } = req.body;

  try {
    const connection = await dbPool.getConnection();

    for (let file of req.files) {
      const filePath = file.path;
      const mimeType = file.mimetype;
      let type = 'document';

      if (mimeType.startsWith('image/')) type = 'image';
      else if (mimeType.startsWith('video/')) type = 'video';
      else if (mimeType.startsWith('audio/')) type = 'audio';

      await connection.execute(
        `INSERT INTO user_library (user_id, file_path, caption, type)
         VALUES (?, ?, ?, ?)`,
        [userId, filePath, caption || null, type]
      );
    }

    connection.release();
    res.json({ status: 'success', message: 'Arquivos adicionados à biblioteca!' });
  } catch (error) {
    console.error('Erro ao salvar na biblioteca:', error);
    res.status(500).send('Erro ao salvar arquivos na biblioteca');
  }
});

app.get('/library', verifyJWT, async (req, res) => {
  const userId = req.userId;

  try {
    const connection = await dbPool.getConnection();
    const [rows] = await connection.execute(
      'SELECT id, file_path, caption, type, created_at FROM user_library WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    connection.release();
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar biblioteca:', error);
    res.status(500).send('Erro ao buscar biblioteca');
  }
});

app.delete('/library/:id', verifyJWT, async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;

  try {
    const connection = await dbPool.getConnection();
    const [rows] = await connection.execute(
      'SELECT file_path FROM user_library WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (rows.length === 0) {
      return res.status(404).send('Arquivo não encontrado');
    }

    const filePath = rows[0].file_path;
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await connection.execute('DELETE FROM user_library WHERE id = ?', [id]);
    connection.release();

    res.send('Arquivo removido com sucesso');
  } catch (error) {
    console.error('Erro ao deletar da biblioteca:', error);
    res.status(500).send('Erro ao remover da biblioteca');
  }
});

// 🔴 STREAMING DE MENSAGENS EM TEMPO REAL (LIVE MONITOR)
app.get('/live-messages', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // Libera o canal de comunicação

    clients.push(res);

    req.on('close', () => {
        const index = clients.indexOf(res);
        if (index !== -1) {
            clients.splice(index, 1);
        }
    });
});

// Função para ver ao vivo as mensagens
function broadcastLiveMessage(data) {
    io.emit('newMessage', data);
}



app.get('/qr-page', (req, res) => {
    const qrPath = path.join(__dirname, 'qr-code.png');

    if (!fs.existsSync(qrPath)) {
        return res.send(`
            <html>
                <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;">
                    <div>
                        <h2>⚠️ QR Code ainda não foi gerado.</h2>
                        <p>Certifique-se de que a sessão foi encerrada e aguarde alguns segundos...</p>
                        <button onclick="location.reload()">🔄 Recarregar</button>
                    </div>
                </body>
            </html>
        `);
    }

    const timestamp = Date.now();

    res.send(`
        <html>
            <body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f4f4f4;">
                <div style="text-align:center;">
                    <h2>📱 Escaneie o QR Code abaixo:</h2>
                    <img src="/qr?t=${timestamp}" alt="QR Code" style="border:1px solid #000;" />
                    <br><br>
                    <button onclick="location.reload()">🔄 Atualizar QR</button>
                </div>
            </body>
        </html>
    `);
});

app.get('/qr', (req, res) => {
    const qrPath = path.join(__dirname, 'qr-code.png');
    if (fs.existsSync(qrPath)) {
        res.setHeader('Content-Type', 'image/png');
        res.sendFile(qrPath);
    } else {
        res.status(404).send('QR Code não encontrado.');
    }
});


app.get('/qr', (req, res) => {
    const qrPath = path.join(__dirname, 'qr-code.png');
    if (fs.existsSync(qrPath)) {
        res.setHeader('Content-Type', 'image/png');
        res.sendFile(qrPath);
    } else {
        res.status(404).send('QR Code não encontrado.');
    }
});






    app.get('/status', (req, res) => {
        const connected = sock && sock.ws && sock.ws.readyState === 1;
        res.json({ connected });
    });

    app.get('/groups', verifyJWT, async (req, res) => {
        try {
            const userId = req.userId;
            let groups = [];
            const connection = await dbPool.getConnection();
            
            const [permissions] = await connection.execute(
                'SELECT * FROM user_group_permissions WHERE user_id = ?',
                [userId]
            );
            
            if (permissions.length > 0) {
                const groupIds = permissions.map(p => p.group_id);
                const [rows] = await connection.execute(
                    'SELECT * FROM group_ids WHERE group_id IN (?)',
                    [groupIds]
                );
                groups = rows;
            } else {
                const [rows] = await connection.execute('SELECT * FROM group_ids');
                groups = rows;
            }
            
            connection.release();
            res.json(groups);
        } catch (error) {
            console.error('Error fetching groups:', error);
            res.status(500).send('An error occurred while fetching groups');
        }
    });
    
app.get('/me', verifyJWT, async (req, res) => {
  try {
    const userId = req.userId;
    const connection = await dbPool.getConnection();

    const [rows] = await connection.execute(`
      SELECT id, email, plan_name, plan_due_date, payment_status
      FROM users
      WHERE id = ?
    `, [userId]);

    connection.release();

    if (rows.length > 0) {
      const user = rows[0];
      res.json({
        id: user.id,
        email: user.email,
        plan_name: user.plan_name || null,
        plan_due_date: user.plan_due_date || null,
        payment_status: user.payment_status || null
      });
    } else {
      res.status(404).json({ error: 'Usuário não encontrado' });
    }
  } catch (error) {
    console.error('Erro ao buscar dados do usuário:', error);
    res.status(500).json({ error: 'Erro ao buscar perfil do usuário' });
  }
});



app.post('/reprocess-failed', verifyJWT, async (req, res) => {
    try {
        const failedMessages = await safeQuery(
            `SELECT * FROM messages_queue WHERE status = 'failed' ORDER BY id DESC LIMIT 1000`
        );

        if (!failedMessages.length) {
            return res.json({ status: 'ok', mensagem: 'Nenhuma mensagem com erro encontrada.' });
        }

        let count = 0;

        for (let msg of failedMessages) {
            const payload = {
                userId: msg.user_id,
                groupId: msg.group_id,
                filePath: msg.file_path,
                caption: msg.caption,
                column: msg.image_url ? 'image_url' : msg.video_url ? 'video_url' : 'file_path',
                status: msg.status,
                scheduledTime: msg.scheduled_time
            };

            await redis.lpush('message_queue', JSON.stringify(payload));
            count++;
        }

        res.json({ status: 'success', reenfileiradas: count });
    } catch (error) {
        console.error('❌ Erro ao reprocessar mensagens com erro:', error);
        res.status(500).send('Erro ao reprocessar mensagens com status failed.');
    }
});

app.get('/contact-messages/:jid', verifyJWT, async (req, res) => {
    const { jid } = req.params;

    try {
        const connection = await dbPool.getConnection();
        const [rows] = await connection.execute(
            'SELECT * FROM messages1 WHERE group_id = ? ORDER BY timestamp DESC', 
            [jid]
        );
        connection.release();
        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar mensagens privadas:', error);
        res.status(500).send('Erro ao buscar mensagens');
    }
});


app.put('/me/update-password', verifyJWT, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.userId;

    try {
        const connection = await dbPool.getConnection();
        
        // Fetch the current user
        const [rows] = await connection.execute('SELECT password FROM users WHERE id = ?', [userId]);
        const user = rows[0];

        // Check if the current password matches
        if (user.password !== currentPassword) {
            connection.release();
            return res.status(400).send('Current password is incorrect');
        }

        // Update the password
        await connection.execute('UPDATE users SET password = ? WHERE id = ?', [newPassword, userId]);
        connection.release();

        res.send('Password updated successfully');
    } catch (error) {
        console.error('Error updating password:', error);
        res.status(500).send('An error occurred while updating the password');
    }
});

    

    app.get('/groups-by-city/:cityId', verifyJWT, async (req, res) => {
        const { cityId } = req.params;
        try {
            const connection = await dbPool.getConnection();
            const [rows] = await connection.execute('SELECT * FROM group_ids WHERE city_id = ?', [cityId]);
            connection.release();
            res.json(rows);
        } catch (error) {
            console.error('Erro ao buscar grupos por cidade:', error);
            res.status(500).send('Erro ao buscar grupos por cidade');
        }
    });

    app.get('/user-cities/:userId', verifyJWT, async (req, res) => {
        const { userId } = req.params;
        try {
            const connection = await dbPool.getConnection();
            const [rows] = await connection.execute(`
                SELECT c.id, c.city_name 
                FROM user_cities uc
                JOIN cities c ON uc.city_id = c.id
                WHERE uc.user_id = ?
            `, [userId]);
            connection.release();
            res.json(rows);
        } catch (error) {
            console.error('Erro ao buscar cidades do usuário:', error);
            res.status(500).send('Erro ao buscar cidades do usuário');
        }
    });

    app.get('/mostrar-nome-cidade-grupos', verifyJWT, async (req, res) => {
        try {
            const connection = await dbPool.getConnection();
            const [rows] = await connection.execute(`
                SELECT 
                    g.id,
                    g.group_id,
                    g.group_name,
                    c.city_name
                FROM 
                    group_ids g
                LEFT JOIN 
                    cities c ON g.city_id = c.id
            `);
            connection.release();
            res.json(rows);
        } catch (error) {
            console.error('Erro ao buscar grupos com nome da cidade:', error);
            res.status(500).send('Erro ao buscar grupos com nome da cidade');
        }
    });

    app.post('/usuario-cidade-plano-disparo', verifyJWT, async (req, res) => {
        const { user_id, city_id } = req.body;
        try {
            const connection = await dbPool.getConnection();
            await connection.execute('INSERT INTO user_cities (user_id, city_id) VALUES (?, ?)', [user_id, city_id]);
            connection.release();
            res.send('Cidade associada ao usuário com sucesso');
        } catch (error) {
            console.error('Erro ao associar cidade ao usuário:', error);
            res.status(500).send('Erro ao associar cidade ao usuário');
        }
    });

    app.get('/usuarios-com-cidades', verifyJWT, async (req, res) => {
        try {
            const connection = await dbPool.getConnection();
            const [rows] = await connection.execute(`
                SELECT u.id, u.email, c.city_name 
                FROM users u 
                LEFT JOIN user_cities uc ON u.id = uc.user_id 
                LEFT JOIN cities c ON uc.city_id = c.id
            `);
            connection.release();
            res.json(rows);
        } catch (error) {
            console.error('Erro ao buscar usuários com cidades:', error);
            res.status(500).send('Erro ao buscar usuários com cidades');
        }
    });

const path = require('path');
app.post('/send-group-message', verifyJWT, async (req, res) => {
  const { groupIds, imageUrl, videoUrl, audioUrl, documentUrl, filePath, caption } = req.body;
  const parsedGroupIds = JSON.parse(groupIds);
  const delay = (ms) => new Promise(res => setTimeout(res, ms));
  const results = [];

  async function validateSocketConnection() {
    if (!sock || !sock.ws || sock.ws.readyState !== 1) {
      console.log('⚠️ WhatsApp desconectado. Tentando reconectar...');
      await connectToWhatsApp();
      await delay(10000);
    }
  }

  try {
    console.log(`🚀 Iniciando envio para ${parsedGroupIds.length} grupos (modo sequencial 1 por minuto)`);

    for (const groupId of parsedGroupIds) {
      try {
        await validateSocketConnection();
        console.log(`📤 Enviando para grupo ${groupId}`);

        const resolvedPath = filePath ? path.resolve(filePath).toString() : null;
        const fileExists = resolvedPath && fs.existsSync(resolvedPath);
        let payload = null;

        if (imageUrl) {
          payload = { image: { url: imageUrl }, caption, jpegThumbnail: Buffer.alloc(0) };
        } else if (videoUrl) {
          payload = { video: { url: videoUrl }, caption };
        } else if (audioUrl) {
          payload = { audio: { url: audioUrl }, caption };
        } else if (documentUrl) {
          payload = { document: { url: documentUrl }, caption };
        } else if (fileExists) {
          // Tenta determinar o tipo MIME para decidir o tipo de mídia
          const mimeType = mime.lookup(resolvedPath) || '';

          if (mimeType.startsWith('image/')) {
            payload = { image: { url: resolvedPath }, caption, jpegThumbnail: Buffer.alloc(0) };
          } else if (mimeType.startsWith('video/')) {
            payload = { video: { url: resolvedPath }, caption };
          } else if (mimeType.startsWith('audio/')) {
            payload = { audio: { url: resolvedPath }, caption };
          } else {
            payload = { document: { url: resolvedPath }, caption };
          }
        } else {
          const msg = `❌ Nenhum caminho de mídia válido fornecido`;
          console.warn(msg);
          results.push({ groupId, status: 'failed', error: msg });
          continue;
        }

        try {
          await sock.sendMessage(groupId, payload);
          console.log(`✅ Mensagem enviada para ${groupId}`);
          results.push({ groupId, status: 'success' });
        } catch (sendError) {
          console.error(`❌ Erro ao enviar para ${groupId}:`, sendError.message);
          results.push({ groupId, status: 'failed', error: sendError.message });

          if (sendError.message.includes('Timed Out') || sendError.message.includes('Connection Closed')) {
            console.log('🔄 Erro crítico detectado, tentando reconectar...');
            await connectToWhatsApp();
            await delay(10000);
            try {
              await sock.sendMessage(groupId, payload);
              console.log(`✅ Reenviado após reconexão para ${groupId}`);
              results.push({ groupId, status: 'success-after-reconnect' });
            } catch (reSendError) {
              console.error(`❌ Falha ao reenviar para ${groupId}:`, reSendError.message);
            }
          }
        }

        console.log(`⏱ Aguardando 60 segundos antes do próximo envio...`);
        await delay(60000); // 1 minuto

      } catch (innerError) {
        console.error(`🚨 Erro inesperado para ${groupId}:`, innerError.message);
        await delay(5000);
      }
    }

    console.log('✅ Finalizado o envio para todos os grupos');
    res.json({ results });

  } catch (error) {
    console.error('🚨 Erro geral na rota /send-group-message:', error);
    res.status(500).send('Erro no servidor ao enviar mensagem');
  }
});






// Endpoint para listar mensagens agendadas
app.get('/schedules', async (req, res) => {
  try {
    const token = req.headers['x-access-token'];
    if (!token) return res.status(401).json({ message: 'Token não fornecido' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.id;

    const scheduledMessages = await db('messages_queue')
      .where({ user_id: userId, status: 'scheduled' })
      .orderBy('scheduled_time', 'asc');

    res.json(scheduledMessages);
  } catch (error) {
    console.error('Erro ao buscar agendamentos:', error);
    res.status(500).json({ message: 'Erro interno do servidor' });
  }
});


    app.post('/disconnect', verifyJWT, async (req, res) => {
        if (sock) {
            await sock.logout();
            const authDir = join(__dirname, 'auth_info_baileys');
            fs.rmSync(authDir, { recursive: true, force: true });
            console.log('WhatsApp disconnected and credentials removed');
            res.send('WhatsApp disconnected and credentials removed');
        } else {
            res.status(500).send('WhatsApp not connected');
        }
    });

    app.post('/reconnect', verifyJWT, async (req, res) => {
        await connectToWhatsApp();
        res.send('WhatsApp reconnecting');
    });

    app.get('/message-stats', async (req, res) => {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).send('Unauthorized');
        }

        try {
            const user = jwt.verify(token, SECRET_KEY);
            const connection = await dbPool.getConnection();
            const [rows] = await connection.execute(
                'SELECT DATE_FORMAT(FROM_UNIXTIME(timestamp / 1000), "%Y-%m-%d %H:%i") as time, COUNT(*) as count FROM messages1 GROUP BY time ORDER BY time'
            );
            connection.release();
            res.json(rows);
        } catch (error) {
            console.error('Error fetching message stats:', error);
            res.status(500).send('An error occurred while fetching message stats');
        }
    });
    
    // Outras rotas e middlewares...
    // Rota para obter o histórico
app.get('/history', verifyJWT, async (req, res) => {
    const userId = req.userId;

    try {
        const connection = await dbPool.getConnection();
        const [rows] = await connection.execute(`
            SELECT * FROM messages_queue WHERE user_id = ?
        `, [userId]);
        connection.release();
        res.json(rows);
    } catch (error) {
        console.error('Error fetching history:', error);
        res.status(500).send('An error occurred while fetching history');
    }
});



    app.get('/message/:id', verifyJWT, async (req, res) => {
        const { id } = req.params;

        try {
            const connection = await dbPool.getConnection();
            const [rows] = await connection.execute('SELECT * FROM messages_queue WHERE id = ?', [id]);
            connection.release();

            if (rows.length > 0) {
                res.json(rows[0]);
            } else {
                res.status(404).send('Message not found');
            }
        } catch (error) {
            console.error('Error fetching message:', error);
            res.status(500).send('An error occurred while fetching message');
        }
    });

    app.get('/group-stats', async (req, res) => {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).send('Unauthorized');
        }

        try {
            const user = jwt.verify(token, SECRET_KEY);
            const connection = await dbPool.getConnection();
            const [rows] = await connection.execute(
                'SELECT group_id as `group`, COUNT(*) as count FROM messages1 GROUP BY group_id'
            );
            connection.release();
            res.json(rows);
        } catch (error) {
            console.error('Error fetching group stats:', error);
            res.status(500).send('An error occurred while fetching group stats');
        }
    });

    app.get('/participant-stats', async (req, res) => {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).send('Unauthorized');
        }

        try {
            const user = jwt.verify(token, SECRET_KEY);
            const connection = await dbPool.getConnection();
            const [rows] = await connection.execute(
                'SELECT group_id as `group`, COUNT(*) as count FROM messages1 GROUP BY group_id'
            );
            connection.release();
            res.json(rows);
        } catch (error) {
            console.error('Error fetching participant stats:', error);
            res.status(500).send('An error occurred while fetching participant stats');
        }
    });

    app.get('/total-messages', async (req, res) => {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).send('Unauthorized');
        }

        try {
            const user = jwt.verify(token, SECRET_KEY);
            const connection = await dbPool.getConnection();
            const [rows] = await connection.execute(
                'SELECT COUNT(*) as total FROM messages1'
            );
            connection.release();
            res.json(rows[0]);
        } catch (error) {
            console.error('Error fetching total messages:', error);
            res.status(500).send('An error occurred while fetching total messages');
        }
    });

    app.get('/user-count', async (req, res) => {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).send('Unauthorized');
        }

        try {
            const user = jwt.verify(token, SECRET_KEY);
            const connection = await dbPool.getConnection();
            const [rows] = await connection.execute(
                'SELECT COUNT(*) as count FROM users'
            );
            connection.release();
            res.json(rows[0]);
        } catch (error) {
            console.error('Error fetching user count:', error);
            res.status(500).send('An error occurred while fetching user count');
        }
    });

    const jwt = require('jsonwebtoken');
const SECRET_KEY = process.env.JWT_SECRET || 'sua-chave-secreta';

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const connection = await dbPool.getConnection();
    const [rows] = await connection.execute('SELECT * FROM users WHERE email = ?', [email]);
    connection.release();

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const user = rows[0];

    // ⚠️ Recomendado: substituir comparação simples por bcrypt.compare(password, user.password)
    if (password !== user.password) {
      return res.status(401).json({ error: 'Senha inválida' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      SECRET_KEY,
      { expiresIn: '30m' }
    );

    res.json({
      auth: true,
      token,
      expiresIn: 1800, // 30 minutos em segundos
    });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro interno no login' });
  }
});


app.post('/refresh-token', verifyJWT, async (req, res) => {
  try {
    const userId = req.userId;
    const connection = await dbPool.getConnection();

    const [rows] = await connection.execute('SELECT id, email FROM users WHERE id = ?', [userId]);
    connection.release();

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const user = rows[0];

    const newToken = jwt.sign(
      { id: user.id, email: user.email },
      SECRET_KEY,
      { expiresIn: '30m' }
    );

    res.json({ token: newToken });
  } catch (error) {
    console.error('Erro ao renovar token:', error);
    res.status(500).json({ error: 'Erro ao renovar o token' });
  }
});


 app.get('/connection-status', verifyJWT, async (req, res) => {
    try {
        const connected = sock && sock.ws && sock.ws.readyState === 1;
        let lastUpdated = null;
        if (connected) {
            const connection = await dbPool.getConnection();
            const [rows] = await connection.execute('SELECT last_updated FROM group_ids ORDER BY last_updated DESC LIMIT 1');
            connection.release();
            if (rows.length > 0) {
                lastUpdated = rows[0].last_updated;
            }
        }
        res.json({ connected, lastUpdated });
    } catch (error) {
        console.error('Error fetching connection status:', error);
        res.status(500).send('An error occurred while fetching connection status');
    }
});


    function verifyAdmin(req, res, next) {
        const userId = req.userId;
        if (userId !== 1) {
            return res.status(403).send('Acesso negado');
        }
        next();
    }

    app.get('/users', verifyJWT, async (req, res) => {
        try {
            const connection = await dbPool.getConnection();
            const [rows] = await connection.execute('SELECT id, email FROM users');
            connection.release();
            res.json(rows);
        } catch (error) {
            console.error('Error fetching users:', error);
            res.status(500).send('An error occurred while fetching users');
        }
    });

    app.put('/users/:id', verifyJWT, async (req, res) => {
        const { id } = req.params;
        const { password } = req.body;

        try {
            const connection = await dbPool.getConnection();
            await connection.execute('UPDATE users SET password = ? WHERE id = ?', [password, id]);
            connection.release();
            res.send('User updated successfully');
        } catch (error) {
            console.error('Error updating user:', error);
            res.status(500).send('An error occurred while updating user');
        }
    });

    app.delete('/users/:id', verifyJWT, async (req, res) => {
        const { id } = req.params;

        try {
            const connection = await dbPool.getConnection();
            await connection.execute('DELETE FROM users WHERE id = ?', [id]);
            connection.release();
            res.send('User deleted successfully');
        } catch (error) {
            console.error('Error deleting user:', error);
            res.status(500).send('An error occurred while deleting user');
        }
    });

    app.post('/register-user', verifyJWT, verifyAdmin, async (req, res) => {
        const { email, password, city_id } = req.body;

        const connection = await dbPool.getConnection();
        const transaction = await connection.beginTransaction();

        try {
            const [result] = await connection.execute('INSERT INTO users (email, password) VALUES (?, ?)', [email, password]);
            const userId = result.insertId;

            await connection.execute('INSERT INTO user_cities (user_id, city_id) VALUES (?, ?)', [userId, city_id]);

            await transaction.commit();
            connection.release();

            res.send('Usuário registrado com sucesso');
        } catch (error) {
            await transaction.rollback();
            connection.release();

            console.error('Erro durante o registro:', error);
            res.status(500).send('Ocorreu um erro durante o registro');
        }
    });

    app.get('/cities', verifyJWT, async (req, res) => {
        try {
            const connection = await dbPool.getConnection();
            const [rows] = await connection.execute('SELECT * FROM cities');
            connection.release();
            res.json(rows);
        } catch (error) {
            console.error('Erro ao buscar cidades:', error);
            res.status(500).send('Ocorreu um erro ao buscar cidades');
        }
    });

    app.post('/add-group', verifyJWT, async (req, res) => {
        const { group_id, group_name, city_id } = req.body;

        try {
            const connection = await dbPool.getConnection();
            await connection.execute('INSERT INTO group_ids (group_id, group_name, city_id) VALUES (?, ?, ?)', [group_id, group_name, city_id]);
            connection.release();

            res.send('Grupo adicionado com sucesso');
        } catch (error) {
            console.error('Erro ao adicionar grupo:', error);
            res.status(500).send('Ocorreu um erro ao adicionar o grupo');
        }
    });

    app.post('/add-city', verifyJWT, async (req, res) => {
        const { city_name } = req.body;

        try {
            const connection = await dbPool.getConnection();
            await connection.execute('INSERT INTO cities (city_name) VALUES (?)', [city_name]);
            connection.release();

            res.send('Cidade adicionada com sucesso');
        } catch (error) {
            console.error('Erro ao adicionar cidade:', error);
            res.status(500).send('Ocorreu um erro ao adicionar a cidade');
        }
    });

    app.get('/cities', verifyJWT, async (req, res) => {
        try {
            const connection = await dbPool.getConnection();
            const [rows] = await connection.execute('SELECT * FROM cities');
            connection.release();
            res.json(rows);
        } catch (error) {
            console.error('Erro ao buscar cidades:', error);
            res.status(500).send('Ocorreu um erro ao buscar as cidades');
        }
    });

    // Rota para buscar todas as cidades
    app.get('/clientes-novo-cadastro-cidades', async (req, res) => {
        try {
            const connection = await dbPool.getConnection();
            const [rows] = await connection.execute('SELECT * FROM cities');
            connection.release();
            res.json(rows);
        } catch (error) {
            console.error('Erro ao buscar cidades:', error);
            res.status(500).send('Ocorreu um erro ao buscar cidades');
        }
    });

    // Configurações do Nodemailer
    const transporter = nodemailer.createTransport({
        host: 'mail.atalk.com.br',
        port: 465,
        secure: true, // true for 465, false for other ports
        auth: {
            user: 'envio@zapfly.pro',
            pass: 'pent2530@MT'
        }
    });

    // Rota para salvar mensagens no banco de dados
app.post('/save-messages', verifyJWT, async (req, res) => {
    const { groupIds, imageUrl, caption } = req.body;
    const userId = req.userId;

    console.log('Recebendo dados:', { userId, groupIds, imageUrl, caption });

    // Verifica se groupIds não é vazio
    if (!groupIds || JSON.parse(groupIds).length === 0) {
        console.log('Nenhum grupo selecionado');
        return res.status(400).send('Nenhum grupo foi selecionado');
    }

    if (!imageUrl || !caption) {
        console.log('Dados faltando:', { groupIds, imageUrl, caption });
        return res.status(400).send('Dados inválidos');
    }

    try {
        const parsedGroupIds = JSON.parse(groupIds);
        console.log('Group IDs após parsing:', parsedGroupIds);

        const connection = await dbPool.getConnection();
        console.log('Conexão com o banco de dados estabelecida');

        for (let groupId of parsedGroupIds) {
            console.log(`Salvando mensagem para o grupo: ${groupId}`);
            const result = await connection.execute(
                'INSERT INTO messages_queue (user_id, group_id, image_url, caption, status) VALUES (?, ?, ?, ?, ?)',
                [userId, groupId, imageUrl, caption, 'pending']
            );
            console.log('Resultado da inserção:', result);
        }
        connection.release();
        console.log('Mensagens salvas com sucesso');
        res.json({ status: 'success' });
    } catch (error) {
        console.error('Erro ao salvar mensagens:', error);
        res.status(500).send('Ocorreu um erro ao salvar as mensagens');
    }
});



    app.post('/stop-message/:id', verifyJWT, async (req, res) => {
        const { id } = req.params;

        try {
            const connection = await dbPool.getConnection();
            await connection.execute('UPDATE messages_queue SET status = ? WHERE id = ?', ['stopped', id]);
            connection.release();
            res.send('Message stopped successfully');
        } catch (error) {
            console.error('Error stopping message:', error);
            res.status(500).send('An error occurred while stopping message');
        }
    });

app.post('/send-group-video', verifyJWT, async (req, res) => {
    const { groupIds, videoUrl, caption } = req.body;

    let parsedGroupIds;
    try {
        parsedGroupIds = JSON.parse(groupIds);
    } catch {
        return res.status(400).send('groupIds inválido');
    }

    if (!videoUrl || parsedGroupIds.length === 0) {
        return res.status(400).send('Dados insuficientes para envio');
    }

    if (!sock || !sock.ws || sock.ws.readyState !== 1) {
        return res.status(500).send('WhatsApp não conectado');
    }

    const results = [];
    const BATCH_LIMIT = 5; // Máximo de grupos por lote
    const DELAY_SEQUENCE = [60000, 90000]; // Delay alternado entre envios
    let delayIndex = 0;

    console.log(`🚀 Iniciando envio para ${parsedGroupIds.length} grupos`);

    for (let i = 0; i < parsedGroupIds.length; i += BATCH_LIMIT) {
        const batch = parsedGroupIds.slice(i, i + BATCH_LIMIT);

        for (const groupId of batch) {
            try {
                await sock.sendMessage(groupId, {
                    video: { url: videoUrl },
                    caption
                });

                console.log(`✅ Vídeo enviado para ${groupId}`);
                results.push({ groupId, status: 'success' });
            } catch (error) {
                console.error(`❌ Falha ao enviar para ${groupId}: ${error.message}`);
                results.push({ groupId, status: 'failed', error: error.message });
            }

            // Alterna delay entre 60s e 90s
            const delayMs = DELAY_SEQUENCE[delayIndex % DELAY_SEQUENCE.length];
            delayIndex++;

            console.log(`⏱ Aguardando ${delayMs / 1000} segundos...`);
            await new Promise(res => setTimeout(res, delayMs));
        }

        // Aguarda 5s entre lotes
        console.log(`📦 Lote concluído. Aguardando 5 segundos...`);
        await new Promise(res => setTimeout(res, 5000));
    }

    res.json({ results });
});




app.post('/auto-cadastro', async (req, res) => {
    const { email, password, city_id } = req.body;

    try {
        const connection = await dbPool.getConnection();

        // Verifica se o usuário já existe
        const [existingUser] = await connection.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (existingUser.length > 0) {
            connection.release();
            return res.status(400).json({ message: 'E-mail já cadastrado.' });
        }

        // Busca o nome da cidade pelo ID
        const [city] = await connection.execute('SELECT city_name FROM cities WHERE id = ?', [city_id]);
        if (city.length === 0) {
            connection.release();
            return res.status(400).json({ message: 'Cidade inválida.' });
        }
        const cityName = city[0].city_name.trim();

        console.log(`Cidade encontrada: ${cityName}`);

        // Define listas de capitais e cidades normais
        const capitalCities = [
            "Cuiaba e Varzea Grande - MT",
            "Porto Velho - RO",
            "Rio Branco - AC",
            "Manaus - AM",
            "Palmas e região - TO"
        ];

        // Determina o link de redirecionamento com base na cidade
        let checkoutUrl;
        if (capitalCities.includes(cityName)) {
            checkoutUrl = 'https://iryd.pay.yampi.com.br/r/AXLO9OZB2Q'; // Link para capitais
        } else {
            checkoutUrl = 'https://iryd.pay.yampi.com.br/r/IKFJKBK7SC'; // Link para cidades normais
        }

        console.log(`URL de Checkout determinado: ${checkoutUrl}`);

        // Insere o novo usuário no banco local
        const [result] = await connection.execute(
            'INSERT INTO users (email, password) VALUES (?, ?)', 
            [email, password]
        );
        const userId = result.insertId;

        console.log(`Usuário cadastrado com ID: ${userId}`);

        // Relaciona o usuário com a cidade
        await connection.execute(
            'INSERT INTO user_cities (user_id, city_id) VALUES (?, ?)', 
            [userId, city_id]
        );

        connection.release();

        console.log(`Usuário relacionado à cidade com sucesso. Redirecionando para: ${checkoutUrl}`);

        // Retornar o link do checkout
        res.json({ redirectUrl: checkoutUrl });
    } catch (error) {
        console.error('Erro ao realizar cadastro:', error);
        res.status(500).json({ message: 'Erro ao realizar cadastro.' });
    }
});






app.get('/group-messages/:groupId', verifyJWT, async (req, res) => {
  const { groupId } = req.params;

  if (!groupId) return res.status(400).send('ID do grupo é obrigatório');

  try {
    const connection = await dbPool.getConnection();

    const [rows] = await connection.execute(
      'SELECT * FROM messages1 WHERE group_id = ? ORDER BY timestamp DESC',
      [groupId]
    );

    connection.release();

    res.json(rows); // Retorna array, mesmo que vazio
  } catch (error) {
    console.error('Erro ao buscar mensagens do grupo:', error);
    res.status(500).send('Erro interno ao buscar mensagens');
  }
});


app.post('/upload-multiple-files', verifyJWT, upload.array('files'), async (req, res) => {
  const { groupIds, caption, scheduledTime } = req.body;
  const userId = req.userId;

  if (!req.files || req.files.length === 0) {
    return res.status(400).send('Nenhum arquivo enviado');
  }

  let parsedGroupIds;
  try {
    parsedGroupIds = JSON.parse(groupIds);
  } catch {
    return res.status(400).send('groupIds inválido');
  }

  if (!Array.isArray(parsedGroupIds) || parsedGroupIds.length === 0) {
    return res.status(400).send('Nenhum grupo selecionado');
  }

  let status = 'pending';
  let parsedScheduledTime = null;

  if (scheduledTime) {
    parsedScheduledTime = new Date(scheduledTime);
    if (parsedScheduledTime <= new Date()) {
      return res.status(400).send('A data de agendamento deve ser no futuro.');
    }
    status = 'scheduled';
  }

  try {
    const connection = await dbPool.getConnection();

    for (let groupId of parsedGroupIds) {
      groupId = String(groupId);

      for (let file of req.files) {
        const filePath = file?.path || null;
        const mimeType = file?.mimetype || '';
        let imageUrl = null, videoUrl = null, audioUrl = null, documentUrl = null;

        if (mimeType.startsWith('image/')) {
          imageUrl = filePath;
        } else if (mimeType.startsWith('video/')) {
          videoUrl = filePath;
        } else if (mimeType.startsWith('audio/')) {
          audioUrl = filePath;
        } else if (
          mimeType === 'application/pdf' ||
          mimeType.includes('msword') ||
          mimeType.includes('excel') ||
          mimeType.includes('powerpoint') ||
          mimeType.includes('officedocument')
        ) {
          documentUrl = filePath;
        }

        const messageData = {
          userId,
          groupId,
          caption,
          image_url: imageUrl,
          video_url: videoUrl,
          audio_url: audioUrl,
          document_url: documentUrl,
          status,
          scheduledTime: parsedScheduledTime
        };

      

        await connection.execute(
          `INSERT INTO messages_queue (user_id, group_id, caption, image_url, video_url, audio_url, document_url, status, scheduled_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            groupId,
            caption,
            imageUrl,
            videoUrl,
            audioUrl,
            documentUrl,
            status,
            parsedScheduledTime
          ]
        );
      }
    }

    connection.release();
    const message = status === 'scheduled' ? 'Mensagem agendada com sucesso.' : 'Mensagem enviada com sucesso.';
    res.json({ status: 'success', message });

  } catch (error) {
    console.error('❌ Erro ao processar o upload e agendamento:', error);
    res.status(500).send('Erro ao processar o upload e agendamento.');
  }
});
app.post('/forcar-disparos', verifyJWT, async (req, res) => {
  try {
    const messages = await safeQuery(
      `SELECT * FROM messages_queue 
       WHERE status = 'failed' 
       AND created_at >= NOW() - INTERVAL 2 HOUR 
       ORDER BY id ASC LIMIT 1000`
    );

    let reenfileiradas = 0;

    for (const msg of messages) {
      const filePath = msg.file_path || msg.image_url || msg.video_url || msg.document_url || msg.audio_url;
      const column = msg.image_url ? 'image_url' :
                     msg.video_url ? 'video_url' :
                     msg.document_url ? 'document_url' :
                     msg.audio_url ? 'audio_url' : null;

      if (filePath && column) {
        const payload = {
          userId: msg.user_id,
          groupId: msg.group_id,
          filePath,
          caption: msg.caption,
          column,
          status: msg.status,
          scheduledTime: msg.scheduled_time
        };

        await redis.lpush('message_queue', JSON.stringify(payload));
        reenfileiradas++;
      }
    }

    res.json({ status: 'ok', reenfileiradas });
  } catch (error) {
    console.error('❌ Erro ao reenfileirar mensagens:', error);
    res.status(500).send('Erro ao reenfileirar mensagens');
  }
});




    app.put('/groups/:id', verifyJWT, async (req, res) => {
        const { id } = req.params;
        const { city_id } = req.body;

        try {
            const connection = await dbPool.getConnection();
            await connection.execute('UPDATE group_ids SET city_id = ? WHERE id = ?', [city_id, id]);
            connection.release();
            res.send('Grupo atualizado com sucesso');
        } catch (error) {
            console.error('Erro ao atualizar grupo:', error);
            res.status(500).send('Ocorreu um erro ao atualizar o grupo');
        }
    });


   http.listen(5175, () => {
    console.log('Server is running on port 5175');
});
}

// Chamando a função init para inicializar a aplicação
// Chama a inicialização principal
init().then(() => {
    // Após init, reprocessa mensagens pendentes
    (async () => {
        try {
            const connectionClosedMessages = await safeQuery(
                "SELECT * FROM messages_queue WHERE status = 'failed' AND error LIKE '%Connection Closed%'"
            );

            for (let msg of connectionClosedMessages) {
                const payload = {
                    userId: msg.user_id,
                    groupId: msg.group_id,
                    filePath: msg.file_path || msg.image_url || msg.video_url || msg.document_url || msg.audio_url,
                    caption: msg.caption,
                    column: msg.image_url ? 'image_url' :
                            msg.video_url ? 'video_url' :
                            msg.document_url ? 'document_url' :
                            msg.audio_url ? 'audio_url' : null,
                    status: msg.status,
                    scheduledTime: msg.scheduled_time
                };

                if (payload.filePath && payload.column) {
                    await redis.lpush('message_queue', JSON.stringify(payload));
                }
            }

            console.log(`🔄 ${connectionClosedMessages.length} mensagens com erro 'Connection Closed' reenfileiradas ao iniciar.`);
        } catch (err) {
            console.error('❌ Erro ao reenfileirar mensagens com erro:', err);
        }
    })();
}).catch(err => {
    console.error('❌ Erro ao inicializar o sistema:', err);
});



