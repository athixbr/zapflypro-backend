// Função de conexão ao WhatsApp

let sock = null;
let authState = null;
let saveCreds = null;

// Adiciona Redis para persistência de sessão
const Redis = require('ioredis');
const redis = new Redis({
    host: 'vps.iryd.com.br',
    port: 6379,
    password: 'pent2530@MT'
});

async function connectToWhatsApp(options = {}, retryCount = 0) {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
    const P = require('pino');
    const qrImage = require('qr-image');
    const fs = require('fs');
    const path = require('path');

    try {
        console.log('🔄 Iniciando conexão com WhatsApp...');
        const { onQR, onStatus } = options || {};


        // Tenta restaurar estado do Redis
        let redisAuth = null;
        try {
            const redisData = await redis.get('wa_auth_state');
            if (redisData) {
                redisAuth = JSON.parse(redisData);
            }
        } catch (e) {
            console.error('Erro ao ler sessão do Redis:', e);
        }

        // Carregar estado de autenticação
        const authInfo = await useMultiFileAuthState('auth_info_baileys');
        if (redisAuth) {
            // Sobrescreve arquivos locais com dados do Redis
            const fs = require('fs');
            const path = require('path');
            for (const [file, content] of Object.entries(redisAuth)) {
                const filePath = path.join('auth_info_baileys', file);
                fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
            }
        }
        authState = authInfo.state;
        saveCreds = async () => {
            await authInfo.saveCreds();
            // Salva todos arquivos de estado no Redis, ignorando arquivos inválidos
            try {
                const fs = require('fs');
                const path = require('path');
                const dir = 'auth_info_baileys';
                const files = fs.readdirSync(dir);
                const stateObj = {};
                for (const file of files) {
                    const filePath = path.join(dir, file);
                    try {
                        const content = fs.readFileSync(filePath, 'utf8');
                        if (content && content.trim().length > 0) {
                            stateObj[file] = JSON.parse(content);
                        } else {
                            // Loga arquivo vazio
                            console.warn('Arquivo de sessão vazio ignorado:', filePath);
                        }
                    } catch (err) {
                        // Loga arquivo corrompido
                        console.warn('Arquivo de sessão inválido ignorado:', filePath, err.message);
                    }
                }
                await redis.set('wa_auth_state', JSON.stringify(stateObj));
            } catch (e) {
                console.error('Erro ao salvar sessão no Redis:', e);
            }
        };

        // Se já existir uma conexão, fazer logout antes de criar nova
        if (sock) {
            try {
                console.log('Desconectando sessão anterior...');
                await sock.logout();
            } catch (err) {
                console.log('Erro ao fazer logout da sessão anterior:', err);
            }
        }

        // Criar nova conexão
        sock = makeWASocket({
            auth: authState,
            printQRInTerminal: false, // Desabilita QR no terminal, vamos emitir via callback
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
        
        // Função para registrar logs
        function logToFile(message) {
            const logPath = path.join(__dirname, 'whatsapp-connection.log');
            const timestamp = new Date().toISOString();
            fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`);
        }
        
        // Configurar eventos

    sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('📱 QR Code recebido. Gerando imagem...');
                const qrCodeImage = qrImage.imageSync(qr, { type: 'png' });
                const qrPath = path.join(__dirname, 'qr-code.png');
                fs.writeFileSync(qrPath, qrCodeImage);
                console.log('✅ QR Code salvo em:', qrPath);
                logToFile('QR Code gerado e salvo');
                // Envia QR em base64 pelo callback, se fornecido
                if (typeof onQR === 'function') {
                    const qrBase64 = Buffer.from(qrCodeImage).toString('base64');
                    onQR(qrBase64);
                }
            } else if (typeof onQR === 'function') {
                // Se não há QR, envia null para limpar
                onQR(null);
            }

            let statusStr = 'desconectado';
            switch (connection) {
                case 'open':
                    global.isWhatsAppConnected = true;
                    statusStr = 'conectado';
                    console.log('✅ Conectado com sucesso ao WhatsApp');
                    logToFile('✅ Conectado com sucesso ao WhatsApp');
                    // Heartbeat para manter conexão ativa
                    setInterval(() => {
                        if (sock && sock.ws && sock.ws.readyState === 1) {
                            sock.sendPresenceUpdate('available');
                        }
                    }, 60000);
                    break;
                case 'close':
                    global.isWhatsAppConnected = false;
                    statusStr = 'desconectado';
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                    const shouldReconnect = !isLoggedOut;
                    const closeMsg = `⚠️ Conexão com o WhatsApp fechada. Causa: ${statusCode} Reconnect? ${shouldReconnect}`;
                    console.warn(closeMsg);
                    logToFile(closeMsg);
                    if (shouldReconnect) {
                        const nextRetry = Math.min(30000, 5000 * (retryCount + 1));
                        const retryMsg = `⏳ Tentando reconectar em ${nextRetry/1000}s... (tentativa ${retryCount+1})`;
                        console.log(retryMsg);
                        logToFile(retryMsg);
                        setTimeout(() => connectToWhatsApp(options, retryCount + 1), nextRetry);
                    } else {
                        const logoutMsg = '🛑 Sessão encerrada (logout). Apague a pasta auth_info_baileys para reconectar.';
                        console.log(logoutMsg);
                        logToFile(logoutMsg);
                    }
                    break;
                case 'connecting':
                    statusStr = 'conectando';
                    break;
                default:
                    statusStr = connection || 'desconhecido';
                    const stateMsg = `ℹ️ Estado da conexão: ${connection}`;
                    console.log(stateMsg);
                    logToFile(stateMsg);
            }
            // Envia status pelo callback, se fornecido
            if (typeof onStatus === 'function') {
                onStatus(statusStr);
            }
        });
        
        sock.ev.on('connection.error', async (error) => {
            console.error('❌ Erro de conexão:', error);
            logToFile(`Erro de conexão: ${error.message}`);
            setTimeout(() => connectToWhatsApp(retryCount + 1), 5000);
        });

        // Configurar processamento de mensagens
        const path = require('path');
        sock.ev.on('messages.upsert', async (msg) => {
            console.log('📥 Nova mensagem recebida:', msg.type);
            const { messages } = msg;
            const fs = require('fs');
            const filePath = path.join(__dirname, 'mensagens_recebidas.json');
            let allMsgs = [];
            try {
                if (fs.existsSync(filePath)) {
                    const raw = fs.readFileSync(filePath, 'utf8');
                    allMsgs = JSON.parse(raw || '[]');
                }
            } catch (e) {
                allMsgs = [];
            }
            for (let message of messages) {
                try {
                    // Salva todas as mensagens, mesmo sem conteúdo
                    allMsgs.push({
                        timestamp: Date.now(),
                        ...message
                    });
                } catch (err) {
                    console.error('❌ Erro ao processar mensagem:', err);
                    logToFile(`Erro ao processar mensagem: ${err.message}`);
                }
            }
            // Limita para não crescer demais (ex: últimas 1000)
            if (allMsgs.length > 1000) allMsgs = allMsgs.slice(-1000);
            try {
                fs.writeFileSync(filePath, JSON.stringify(allMsgs, null, 2));
            } catch (e) {
                console.error('❌ Erro ao salvar mensagens recebidas:', e);
            }
        });
        
        return sock;
    } catch (err) {
        console.error('❌ Erro ao conectar com WhatsApp:', err);
        logToFile(`Erro fatal ao conectar: ${err.message}`);
        setTimeout(() => connectToWhatsApp(retryCount + 1), 10000);
    }
}

module.exports = { connectToWhatsApp, getSock: () => sock };
