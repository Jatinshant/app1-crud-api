require('dotenv').config();
const express = require('express');
const itemsRoutes = require('./routes/items.routes');
const healthRoutes = require('./routes/health.routes');

const app = express();
app.use(express.json());

app.use('/items', itemsRoutes);
app.use('/', healthRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`App 1 running on port ${PORT}`);
});
