const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    servicio: 'auy1104-api-ejemplo',
    mensaje: 'El servicio está en ejecución',
  });
});

app.get('/api/saludo', (req, res) => {
  const nombre = req.query.nombre || 'estudiante';
  res.json({
    metodo: 'GET',
    ruta: '/api/saludo',
    mensaje: `Hola, ${nombre}. Esta es una respuesta JSON de ejemplo.`,
  });
});

app.post('/api/echo', (req, res) => {
  const cuerpo = req.body && typeof req.body === 'object' ? req.body : {};
  res.status(201).json({
    metodo: 'POST',
    ruta: '/api/echo',
    recibido: cuerpo,
    nota: 'El servidor devuelve lo que enviaste en el cuerpo (útil para practicar POST + JSON).',
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

app.listen(PORT, () => {
  console.log(`API escuchando en http://0.0.0.0:${PORT}`);
});
