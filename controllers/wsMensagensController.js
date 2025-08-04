let wsGrupoNamespace = null;

function initWebSocket(io) {
    wsGrupoNamespace = io.of('/ws-mensagens-grupo');

    wsGrupoNamespace.on('connection', (socket) => {
        console.log('📡 Cliente conectado em /ws-mensagens-grupo');

        socket.on('disconnect', () => {
            console.log('❌ Cliente saiu do grupo');
        });
    });
}

function emitirMensagemGrupo(data) {
    if (wsGrupoNamespace) {
        wsGrupoNamespace.emit('novaMensagemGrupo', data);
    }
}

module.exports = {
    initWebSocket,
    emitirMensagemGrupo
};
