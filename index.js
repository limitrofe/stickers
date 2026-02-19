const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Queue, Worker } = require('bullmq');
const { Sticker } = require('wa-sticker-formatter');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

// --- Configuration ---
const REDIS_CONNECTION = {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
};

// Ensure temp directory exists
if (!fs.existsSync('temp')) {
    fs.mkdirSync('temp');
}

// --- WhatsApp Client Setup ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ],
        headless: true,
        dumpio: true // Enable browser logging to stdout/stderr for debugging
    }
});

client.on('qr', (qr) => {
    console.log('QR CODE STRING (Copy this if the image is bad):');
    console.log(qr);
    
    // Generate terminal QR with small flag
    qrcode.generate(qr, { small: true });
    console.log('Scan the QR Code above to log in!');
});

client.on('loading_screen', (percent, message) => {
    console.log('LOADING SCREEN', percent, message);
});

client.on('authenticated', () => {
    console.log('AUTHENTICATED');
});

client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
});

client.on('ready', () => {
    console.log('Client is ready!');
});

// ... (other code)

// Start Client
console.log('Initializing WhatsApp Client...');
client.initialize().catch(err => console.error('Client Initialization Error:', err));

// --- Queue & Worker Setup ---
let stickerQueue;

// Check if Redis is available (simple check: is Docker running? No great way to check from Node without connection error)
// So we try to connect, if fail, fallback? 
// Actually, BullMQ requires Redis. For local test WITHOUT Redis, we need a mock.
// Let's implement a simple in-memory queue if REDIS_HOST is 'localhost' and we assume no Redis.

const useRedis = process.env.REDIS_HOST !== undefined; 

if (useRedis) {
    stickerQueue = new Queue('stickerQueue', { connection: REDIS_CONNECTION });
    
    const stickerWorker = new Worker('stickerQueue', async job => {
       await processStickerJob(job.data);
    }, { 
        connection: REDIS_CONNECTION,
        limiter: { max: 1, duration: 2000 }
    });
} else {
    console.log('⚠️ Running in local mode (In-Memory Queue). Redis is required for production.');
    
    // Simple in-memory queue implementation
    stickerQueue = {
        add: async (name, data) => {
            console.log('Adding to in-memory queue...');
            // Process immediately with delay to simulate queue
            setTimeout(() => processStickerJob(data), 1000);
        }
    };
}

// --- Setup @imgly/background-removal-node ---
const { removeBackground } = require('@imgly/background-removal-node');
const sharp = require('sharp');

// Helper: Add White Outline
async function addWhiteOutline(buffer) {
    try {
        const image = sharp(buffer);
        
        // 1. Resize image to be smaller than 512x512 to leave room for the stroke
        // e.g., 400x400 inside a 512x512 canvas
        const size = 400;
        const padding = 512;
        
        // Create 512x512 transparent canvas and center resized image
        const resized = await image
            .resize({ 
                width: size, 
                height: size, 
                fit: 'contain', 
                background: { r: 0, g: 0, b: 0, alpha: 0 } 
            })
            .toBuffer();

        const centered = await sharp({
            create: { width: padding, height: padding, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
        })
        .composite([{ input: resized }])
        .png()
        .toBuffer();
            
        // 2. Create the outline mask from the centered image
        const alpha = await sharp(centered)
            .ensureAlpha()
            .extractChannel('alpha')
            .toBuffer();

        // Blur radius
        const strokeWidth = 15; // Width of the stroke
        
        const outlineMask = await sharp(alpha)
            .blur(strokeWidth) 
            .threshold(50, { grayscale: true }) // Cutoff to create solid shape
            .toBuffer();

        // 3. Create the White Stroke Layer
        // Create a solid white image and apply the outline mask to it
        const whiteLayer = await sharp({
            create: {
                width: padding,
                height: padding,
                channels: 4,
                background: { r: 255, g: 255, b: 255, alpha: 255 }
            }
        })
        .composite([{ input: outlineMask, blend: 'dest-in' }]) // THE FIX: Apply mask to cut out the shape
        .png()
        .toBuffer();

        // 4. Put Original on top of White Silhouette
        const finalImage = await sharp(whiteLayer)
            .composite([{ input: centered }])
            .toBuffer();

        return finalImage;

    } catch (e) {
        console.error('Outline generation failed:', e);
        return buffer; 
    }
}

// Shared Processor Function
async function processStickerJob(data) {
    const { chatId, filePath, originalMessageId } = data;
    console.log(`Processing job for ${chatId}`);

    try {
        if (!fs.existsSync(filePath)) {
            throw new Error('File not found');
        }

        let mediaData = fs.readFileSync(filePath);

        // --- 1. BACKGROUND REMOVAL ---
        try {
            console.log('Removing background...');
            // removeBackground returns a Blob (usually PNG)
            const blob = await removeBackground(`file://${filePath}`); 
            const arrayBuffer = await blob.arrayBuffer();
            
            // Validate if we got a valid buffer
            if (arrayBuffer.byteLength > 0) {
                 mediaData = Buffer.from(arrayBuffer);
                 console.log(`Background removed! New size: ${mediaData.length} bytes`);
            } else {
                 console.warn('Background removal returned empty buffer. Using original.');
            }
            
        } catch (bgError) {
            console.error('Background removal failed:', bgError);
        }

        // --- 2. WHITE OUTLINE ---
        try {
            console.log('Adding outline...');
            mediaData = await addWhiteOutline(mediaData);
            console.log('Outline added!');
        } catch (outlineError) {
            console.error('Outline failed:', outlineError);
        }

        // --- 3. CONVERT TO STICKER ---
        const sticker = new Sticker(mediaData, {
            pack: 'Sticker Bot',
            author: 'Seu Nome',
            type: 'full', // 'full' is better now that we have our own compositing
            quality: 100,
            background: 'transparent'
        });

        const buffer = await sticker.build();
        const media = new MessageMedia('image/webp', buffer.toString('base64'));

        // Send sticker back to the user
        await client.sendMessage(chatId, media, { sendMediaAsSticker: true });
        console.log(`Sticker sent to ${chatId}`);

        // Cleanup
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    } catch (error) {
        console.error(`Job failed:`, error);
    }
}

// --- Rate Limiting Setup ---
const DAILY_LIMIT = 25;
const MAX_FILE_SIZE_BYTES = 200 * 1024; // 200KB
const userUsage = new Map(); // Key: chatId, Value: { count: 0, date: 'YYYY-MM-DD' }

function checkRateLimit(chatId) {
    const today = new Date().toISOString().split('T')[0];
    let usage = userUsage.get(chatId);

    if (!usage || usage.date !== today) {
        usage = { count: 0, date: today };
        userUsage.set(chatId, usage);
    }

    if (usage.count >= DAILY_LIMIT) {
        return false;
    }

    usage.count++;
    return true;
}

// --- Message Listener ---
client.on('message_create', async msg => {
    // Determine chat ID (handle 'Note to Self' vs normal chat)
    const chatId = msg.from;

    // IGNORE GROUPS AND STATUS UPDATES
    if (chatId.includes('@g.us') || chatId === 'status@broadcast') {
        return;
    }

    // Filter: Only process images
    if (msg.hasMedia && msg.type === 'image') {
        console.log(`Received image from ${chatId}`);

        // 1. Check Rate Limit
        if (!checkRateLimit(chatId)) {
            console.log(`User ${chatId} exceeded daily limit.`);
            await msg.reply(`🚫 *Limite Diário Atingido*\n\nVocê já gerou ${DAILY_LIMIT} figurinhas hoje. Tente novamente amanhã!`);
            return;
        }

        try {
            const media = await msg.downloadMedia();
            
            // 2. Check File Size (media.data is base64, so approximate size check)
            // Base64 is ~33% larger than binary. 
            const bufferLength = Buffer.from(media.data, 'base64').length;
            
            if (bufferLength > MAX_FILE_SIZE_BYTES) {
                console.log(`File too large: ${bufferLength} bytes`);
                await msg.reply(`⚠️ *Arquivo Muito Grande*\n\nSua imagem tem ${(bufferLength / 1024).toFixed(0)}KB. O limite é 200KB.\n\nTente diminuir a qualidade ou cortar a imagem.`);
                return;
            }

            if (media.mimetype.startsWith('image/')) {
                // Save to temp file
                const filename = `${msg.id.id}.${mime.extension(media.mimetype)}`;
                const filePath = path.join(__dirname, 'temp', filename);
                
                fs.writeFileSync(filePath, media.data, { encoding: 'base64' });

                // Add to Queue
                // Note: stickerQueue might be in-memory or Redis based on setup above
                if (stickerQueue && typeof stickerQueue.add === 'function') {
                    await stickerQueue.add('convert', {
                        chatId: chatId,
                        filePath: filePath,
                        originalMessageId: msg.id.id
                    });
                    console.log(`Queued image from ${chatId}`);
                } else {
                    console.error('Queue not initialized');
                }
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    }
    
    // Legacy command: !figurinhas (Bulk Send from Desktop)
    if (msg.body === '!figurinhas' && msg.fromMe) {
        // Disabled for now
       // await msg.reply('O sistema foi atualizado! Agora basta me enviar as imagens diretamente que eu converto.');
    }
});

// Start Client
client.initialize();

// --- Web Server for Health Check & Landing Page ---
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.static('public'));

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
