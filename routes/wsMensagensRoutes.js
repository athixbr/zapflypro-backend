const express = require('express');
const router = express.Router();

router.get('/status', (req, res) => {
  res.json({ status: 'WebSocket OK', time: new Date().toISOString() });
});

module.exports = router;
