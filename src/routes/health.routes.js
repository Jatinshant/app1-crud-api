const express = require('express');
const router = express.Router();
const prisma = require('../config/prisma');

router.get('/health', async (req, res) => {
  const health = { app: 'ok', db: 'unknown' };
  try {
    await prisma.$queryRaw`SELECT 1`;
    health.db = 'ok';
    return res.status(200).json({ status: 'healthy', checks: health });
  } catch (err) {
    health.db = 'fail';
    return res.status(503).json({ status: 'unhealthy', checks: health, error: err.message });
  }
});

module.exports = router;
