require('dotenv').config();
const express = require('express');
const AWS = require('aws-sdk');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');

// Cargar documentación Swagger desde YAML
const swaggerDocument = YAML.load('./swagger.yaml');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Configuración de Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Configura AWS
AWS.config.update({
  region: process.env.AWS_REGION || 'us-east-1',
});

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const dynamoDB = new AWS.DynamoDB.DocumentClient();

// Configuración de Multer para almacenamiento temporal de imágenes
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = 'uploads/';
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath);
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB límite
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no soportado. Solo se permiten imágenes (JPEG, PNG, GIF).'));
    }
  },
});

// Middleware para limpiar archivos temporales
const cleanTempFiles = (req, res, next) => {
  if (req.file) {
    fs.unlink(req.file.path, (err) => {
      if (err) console.error('Error al eliminar archivo temporal:', err);
    });
  }
  next();
};

// Ruta de prueba de conexión AWS
app.get('/test-aws', async (req, res) => {
  try {
    // 1. Probar conexión con DynamoDB
    const dynamo = new AWS.DynamoDB();
    const tables = await dynamo.listTables().promise();
    
    // 2. Probar conexión con S3
    const s3Params = {
      Bucket: process.env.S3_BUCKET_NAME,
      MaxKeys: 1
    };
    const s3Objects = await s3.listObjectsV2(s3Params).promise();
    
    res.status(200).json({
      dynamoDB: {
        connected: true,
        tables: tables.TableNames,
        message: 'Conexión con DynamoDB exitosa'
      },
      s3: {
        connected: true,
        objectsCount: s3Objects.KeyCount,
        message: 'Conexión con S3 exitosa'
      }
    });
  } catch (error) {
    console.error('Error en test-aws:', error);
    res.status(500).json({
      error: 'Error al conectar con AWS',
      details: {
        dynamoDB: {
          connected: false,
          error: error.code === 'ResourceNotFoundException' ? 'Tabla no encontrada' : error.message
        },
        s3: {
          connected: false,
          error: error.code === 'NoSuchBucket' ? 'Bucket no encontrado' : error.message
        }
      }
    });
  }
});

// Ruta de inicio - Muestra todas las rutas disponibles
app.get('/', (req, res) => {
  res.status(200).json({
    status: 200,
    message: 'API de Talleres funcionando correctamente',
    version: '1.0.0',
    routes: {
      docs: '/api-docs',
      test: '/test-aws',
      talleres: {
        create: 'POST /talleres',
        getAll: 'GET /talleres',
        getOne: 'GET /talleres/:tallerId',
        delete: 'DELETE /talleres/:tallerId'
      },
      slides: {
        add: 'POST /talleres/:tallerId/slides'
      }
    }
  });
});

// Ruta 1: Crear taller con portada
app.post(
  '/talleres',
  upload.single('portada'),
  async (req, res, next) => {
    const { 
      nombre, 
      descripcion, 
      duracion, 
      nivelDificultad, 
      materiales, 
      objetivos,
      finalidades,
      ciencia,
      tecnologia,
      ingenieria,
      matematicas
    } = req.body;
    const portada = req.file;

    if (!nombre || !descripcion) {
      return res.status(400).json({ error: "Nombre y descripción son requeridos" });
    }

    if (!portada) {
      return res.status(400).json({ error: "La portada es requerida" });
    }

    const tallerId = uuidv4();

    try {
      // Subir portada a S3
      const portadaFileName = `portada-${uuidv4()}${path.extname(portada.originalname)}`;
      const portadaContent = fs.readFileSync(portada.path);
      
      const portadaS3Params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `talleres/${tallerId}/${portadaFileName}`,
        Body: portadaContent,
        ContentType: portada.mimetype
      };

      const portadaS3Response = await s3.upload(portadaS3Params).promise();

      // Crear taller en DynamoDB
      const tallerParams = {
        TableName: 'Talleres',
        Item: {
          id: tallerId,
          nombre,
          descripcion,
          duracion: duracion || null,
          nivelDificultad: nivelDificultad || 'FÁCIL',
          materiales: materiales || null,
          objetivos: objetivos || null,
          finalidades: finalidades || null,
          ciencia: ciencia || null,
          tecnologia: tecnologia || null,
          ingenieria: ingenieria || null,
          matematicas: matematicas || null,
          portadaUrl: portadaS3Response.Location,
          carpetaS3: `talleres/${tallerId}/`,
          createdAt: new Date().toISOString(),
          slides: [] // Array para almacenar los slides
        },
      };

      await dynamoDB.put(tallerParams).promise();
      
      res.status(201).json({
        id: tallerId,
        nombre,
        descripcion,
        duracion: tallerParams.Item.duracion,
        nivelDificultad: tallerParams.Item.nivelDificultad,
        materiales: tallerParams.Item.materiales,
        objetivos: tallerParams.Item.objetivos,
        finalidades: tallerParams.Item.finalidades,
        ciencia: tallerParams.Item.ciencia,
        tecnologia: tallerParams.Item.tecnologia,
        ingenieria: tallerParams.Item.ingenieria,
        matematicas: tallerParams.Item.matematicas,
        portadaUrl: portadaS3Response.Location,
        carpetaS3: tallerParams.Item.carpetaS3,
        createdAt: tallerParams.Item.createdAt
      });
    } catch (error) {
      console.error('Error al crear taller:', error);
      res.status(500).json({ error: "Error al crear taller", details: error.message });
    } finally {
      next();
    }
  },
  cleanTempFiles
);

// Ruta 2: Agregar slide a un taller - VERSIÓN CORREGIDA
app.post(
  '/talleres/:tallerId/slides',
  upload.single('imagen'),
  async (req, res, next) => {
    const tallerId = req.params.tallerId;
    const { descripcion } = req.body;
    const imagen = req.file;

    if (!descripcion) {
      return res.status(400).json({ error: "Descripción es requerida" });
    }

    try {
      // Verificar si el taller existe
      const taller = await dynamoDB.get({
        TableName: 'Talleres',
        Key: { id: tallerId }
      }).promise();

      if (!taller.Item) {
        return res.status(404).json({ error: "Taller no encontrado" });
      }

      let imagenUrl = null;
      if (imagen) {
        // Subir imagen del slide a S3
        const imagenFileName = `slide-${uuidv4()}${path.extname(imagen.originalname)}`;
        const imagenContent = fs.readFileSync(imagen.path);
        
        const imagenS3Params = {
          Bucket: process.env.S3_BUCKET_NAME,
          Key: `talleres/${tallerId}/${imagenFileName}`,
          Body: imagenContent,
          ContentType: imagen.mimetype
        };

        const imagenS3Response = await s3.upload(imagenS3Params).promise();
        imagenUrl = imagenS3Response.Location;
      }

      // Crear el nuevo slide
      const nuevoSlide = {
        id: uuidv4(),
        titulo: `Paso ${taller.Item.slides ? taller.Item.slides.length + 1 : 1}`,
        descripcion,
        imagenUrl,
        createdAt: new Date().toISOString()
      };

      // Determinar la expresión de actualización basada en si ya existen slides
      let updateExpression;
      let expressionAttributeValues;
      
      if (taller.Item.slides && taller.Item.slides.length > 0) {
        // Si ya hay slides, añadir al array existente
        updateExpression = 'SET slides = list_append(slides, :nuevo_slide), updatedAt = :updatedAt';
        expressionAttributeValues = {
          ':nuevo_slide': [nuevoSlide],
          ':updatedAt': new Date().toISOString()
        };
      } else {
        // Si no hay slides, crear un nuevo array
        updateExpression = 'SET slides = :nuevo_slide, updatedAt = :updatedAt';
        expressionAttributeValues = {
          ':nuevo_slide': [nuevoSlide],
          ':updatedAt': new Date().toISOString()
        };
      }

      // Actualizar el taller
      const updateParams = {
        TableName: 'Talleres',
        Key: { id: tallerId },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      };

      const updatedTaller = await dynamoDB.update(updateParams).promise();

      res.status(201).json({
        slide: nuevoSlide,
        taller: updatedTaller.Attributes
      });
    } catch (error) {
      console.error('Error al agregar slide:', error);
      res.status(500).json({ 
        error: "Error al agregar slide", 
        details: error.message,
        stack: error.stack
      });
    } finally {
      next();
    }
  },
  cleanTempFiles
);

// Ruta 3: Obtener un taller con sus slides
app.get('/talleres/:tallerId', async (req, res) => {
  const tallerId = req.params.tallerId;

  try {
    const taller = await dynamoDB.get({
      TableName: 'Talleres',
      Key: { id: tallerId }
    }).promise();

    if (!taller.Item) {
      return res.status(404).json({ error: "Taller no encontrado" });
    }

    res.json(taller.Item);
  } catch (error) {
    console.error('Error al obtener taller:', error);
    res.status(500).json({ error: "Error al obtener taller", details: error.message });
  }
});

// Ruta 4: Obtener todos los talleres (solo datos básicos)
app.get('/talleres', async (req, res) => {
  try {
    const params = {
      TableName: 'Talleres',
      ProjectionExpression: 'id, nombre, descripcion, duracion, nivelDificultad, portadaUrl, createdAt'
    };
    const data = await dynamoDB.scan(params).promise();
    res.json(data.Items || []);
  } catch (error) {
    console.error('Error al obtener talleres:', error);
    res.status(500).json({ error: "Error al obtener talleres", details: error.message });
  }
});

// Ruta 5: Eliminar un taller con todo su contenido
app.delete('/talleres/:tallerId', async (req, res) => {
  const tallerId = req.params.tallerId;

  try {
    // Verificar si el taller existe
    const taller = await dynamoDB.get({
      TableName: 'Talleres',
      Key: { id: tallerId }
    }).promise();

    if (!taller.Item) {
      return res.status(404).json({ error: "Taller no encontrado" });
    }

    // Eliminar todo el contenido del folder en S3
    const listParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Prefix: `talleres/${tallerId}/`
    };

    const listedObjects = await s3.listObjectsV2(listParams).promise();

    if (listedObjects.Contents.length > 0) {
      const deleteParams = {
        Bucket: process.env.S3_BUCKET_NAME,
        Delete: { Objects: [] }
      };

      listedObjects.Contents.forEach(({ Key }) => {
        deleteParams.Delete.Objects.push({ Key });
      });

      await s3.deleteObjects(deleteParams).promise();

      // Si hay más de 1000 objetos, necesitaríamos paginación
      if (listedObjects.IsTruncated) {
        console.warn('El taller tiene más de 1000 objetos, no todos fueron eliminados');
      }
    }

    // Eliminar el taller de DynamoDB
    await dynamoDB.delete({
      TableName: 'Talleres',
      Key: { id: tallerId }
    }).promise();

    res.status(200).json({ message: "Taller eliminado correctamente" });
  } catch (error) {
    console.error('Error al eliminar taller:', error);
    res.status(500).json({ error: "Error al eliminar taller", details: error.message });
  }
});

// Middleware para manejar errores
app.use((err, req, res, next) => {
  console.error(err.stack);
  
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  
  res.status(500).json({ error: 'Algo salió mal en el servidor!', details: err.message });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API corriendo en http://localhost:${PORT}`);
  console.log(`Documentación Swagger disponible en http://localhost:${PORT}/api-docs`);
  console.log(`Ruta de inicio disponible en http://localhost:${PORT}/`);
  console.log(`Ruta de prueba AWS disponible en http://localhost:${PORT}/test-aws`);
});