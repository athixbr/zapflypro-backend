// Função de conexão ao WhatsApp
let sock = null;
let authState = null;
let saveCreds = null;

async function connectToWhatsApp(retryCount = 0) {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
    const P = require('pino');
    const qrImage = require('qr-image');
    const fs = require('fs');
    const path = require('path');

    try {
        console.log('🔄 Iniciando conexão com WhatsApp...');
        
        // Carregar estado de autenticação
        const authInfo = await useMultiFileAuthState('auth_info_baileys');
        authState = authInfo.state;
        saveCreds = authInfo.saveCreds;
        
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
            }
            
            switch (connection) {
                case 'open':
                    global.isWhatsAppConnected = true;
                    console.log('✅ Conectado com sucesso ao WhatsApp');
                    logToFile('✅ Conectado com sucesso ao WhatsApp');
                    
                    // Heartbeat para manter conexão ativa
                    setInterval(() => {
                        if (sock && sock.ws && sock.ws.readyState === 1) {
                            sock.sendPresenceUpdate('available');
                        }
                    }, 60000); // a cada 1 minuto
                    
                    break;
                    
                case 'close':
                    global.isWhatsAppConnected = false;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                    const shouldReconnect = !isLoggedOut;
                    
                    const closeMsg = `⚠️ Conexão com o WhatsApp fechada. Causa: ${statusCode} Reconnect? ${shouldReconnect}`;
                    console.warn(closeMsg);
                    logToFile(closeMsg);
                    
                    if (shouldReconnect) {
                        // Estratégia de backoff exponencial
                        const nextRetry = Math.min(30000, 5000 * (retryCount + 1));
                        const retryMsg = `⏳ Tentando reconectar em ${nextRetry/1000}s... (tentativa ${retryCount+1})`;
                        console.log(retryMsg);
                        logToFile(retryMsg);
                        setTimeout(() => connectToWhatsApp(retryCount + 1), nextRetry);
                    } else {
                        const logoutMsg = '🛑 Sessão encerrada (logout). Apague a pasta auth_info_baileys para reconectar.';
                        console.log(logoutMsg);
                        logToFile(logoutMsg);
                    }
                    break;
                    
                default:
                    const stateMsg = `ℹ️ Estado da conexão: ${connection}`;
                    console.log(stateMsg);
                    logToFile(stateMsg);
            }
        });
        
        sock.ev.on('connection.error', async (error) => {
            console.error('❌ Erro de conexão:', error);
            logToFile(`Erro de conexão: ${error.message}`);
            setTimeout(() => connectToWhatsApp(retryCount + 1), 5000);
        });

        // Configurar processamento de mensagens
        sock.ev.on('messages.upsert', async (msg) => {
            console.log('📥 Nova mensagem recebida:', msg.type);
            
            const { messages } = msg;
            
            for (let message of messages) {
                try {
                    if (!message.message) {
                        console.warn('⚠️ Mensagem ignorada: conteúdo criptografado ou sessão ausente');
                        continue;
                    }
                    
                    const groupId = message.key?.remoteJid || null;
                    const senderId = message.key?.participant || null;
                    
                    if (!groupId || !groupId.endsWith('@g.us')) {
                        console.log('📭 Ignorado: mensagem não é de grupo.');
                        continue;
                    }
                    
                    console.log(`✅ Mensagem processada do grupo ${groupId}`);
                } catch (err) {
                    console.error('❌ Erro ao processar mensagem:', err);
                    logToFile(`Erro ao processar mensagem: ${err.message}`);
                }
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
