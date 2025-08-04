let wsContatoNamespace = null;

function initWebSocketContato(io) {
    wsContatoNamespace = io.of('/ws-mensagens-contato');

    wsContatoNamespace.on('connection', (socket) => {
        console.log('📡 Cliente conectado em /ws-mensagens-contato');

        socket.on('disconnect', () => {
            console.log('❌ Cliente saiu do contato');
        });
    });
}

function emitirMensagemContato(data) {
    if (wsContatoNamespace) {
        wsContatoNamespace.emit('novaMensagemContato', data);
    }
}

module.exports = {
    initWebSocketContato,
    emitirMensagemContato
};
