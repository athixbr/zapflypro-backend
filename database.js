const mysql = require('mysql2/promise');

// Database connection pool
let dbPool;

// Connect to database function
async function connectToDatabase() {
    try {
        console.log('🔌 Conectando ao banco de dados...');
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
        
        // Test connection
        const conn = await dbPool.getConnection();
        await conn.ping();
        conn.release();
        console.log('✅ Conectado ao banco de dados com sucesso');
        return dbPool;
    } catch (err) {
        console.error('❌ Erro ao conectar ao banco:', err);
        setTimeout(connectToDatabase, 5000); // retry after 5 seconds
        throw err;
    }
}

// Initialize connection on module load
connectToDatabase().catch(err => {
    console.error('❌ Falha na conexão inicial com o banco:', err);
});

// Safe query execution function
async function safeQuery(query, params = []) {
    if (!dbPool) {
        try {
            await connectToDatabase(); // Tenta reconectar se não houver pool
        } catch (error) {
            console.error('❌ Erro ao reconectar com banco:', error);
            throw error;
        }
    }
    
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

// Get database pool
function getDbPool() {
    return dbPool;
}

// Export
module.exports = { 
    safeQuery,
    getDbPool,
    connectToDatabase
};
