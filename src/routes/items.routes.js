const express = require('express');
const router = express.Router();
const prisma = require('../config/prisma');

// Create
router.post('/', async (req, res) => {
  try {
    const { name, quantity } = req.body;
    const item = await prisma.item.create({ data: { name, quantity } });
    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read all
router.get('/', async (req, res) => {
  const items = await prisma.item.findMany();
  res.json(items);
});

// Read one
router.get('/:id', async (req, res) => {
  const item = await prisma.item.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

// Update
router.put('/:id', async (req, res) => {
  try {
    const { name, quantity } = req.body;
    const item = await prisma.item.update({
      where: { id: req.params.id },
      data: { name, quantity },
    });
    res.json(item);
  } catch (err) {
    res.status(404).json({ error: 'Not found' });
  }
});

// Delete
router.delete('/:id', async (req, res) => {
  try {
    await prisma.item.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    res.status(404).json({ error: 'Not found' });
  }
});

module.exports = router;
