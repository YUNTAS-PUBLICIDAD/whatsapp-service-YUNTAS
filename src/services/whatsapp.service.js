import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import fs from 'fs';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import logger from './logger.service.js';
import { API_URL, IS_DEV, WHATSAPP_CONFIG } from '../config/constants.js';

const extractMessage = (msg) => {
  if(!msg.message) return null;
  const m = msg.message;
  if(m.conversation) return m.conversation;
  if(m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if(m.ephemeralMessage?.message){
    return extractMessage({message: m.ephemeralMessage.message})
  }
  if(m.viewOnceMessage?.message){
    return extractMessage({message: m.viewOnceMessage.message})
  }
  return null;
}

class WhatsAppService {
    constructor() {
        this.sock = null;
        this.currentQR = null;
        this.isReady = false;
        this.isInitializing = false;
        this.qrTimeout = null;
        this.eventEmitter = null;
    }

    /**
     * Establece el emisor de eventos para Socket.IO
     */
    setEventEmitter(io) {
        this.eventEmitter = io;
    }

    /**
     * Emite evento de actualización de QR
     */
    emitQRUpdate(data) {
        if (this.eventEmitter) {
            this.eventEmitter.emit('qr-update', data);
        }
    }

    /**
     * Inicializa el cliente de WhatsApp
     */
    async initialize() {
        if (this.sock || this.isInitializing) {
            logger.warn('Cliente de WhatsApp ya existe, cancelando inicialización');
            return;
        }

        try {
            this.isInitializing = true;

            // se crea la carpeta de autenticacion si no existe
            if (!fs.existsSync(WHATSAPP_CONFIG.authPath)) {
                fs.mkdirSync(WHATSAPP_CONFIG.authPath, { recursive: true });
            }

            const { state, saveCreds } = await useMultiFileAuthState(WHATSAPP_CONFIG.authPath);

            const { version } = await fetchLatestBaileysVersion(); // version mas reciente

            this.sock = makeWASocket({ // socket de WhatsApp
                version,
                logger: pino({ level: 'info' }),
                printQRInTerminal: false,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
                },
                browser: [WHATSAPP_CONFIG.sessionName, 'Chrome', '120.0.0'],
                generateHighQualityLinkPreview: true,
                syncFullHistory: false,
                markOnlineOnConnect: false
            });

            this.sock.ev.on('messages.upsert', async ({messages, type}) => {
              if(type !== 'notify') return;
              logger.debug('EVENT TYPE:', type);

              for(const msg of messages){
                try{
                  // Ignorar mensajes propios
                  // if(msg.key.fromMe) continue;
                  if(!IS_DEV && msg.key.fromMe){
                    continue;
                  }

                  const rawJid = msg.key.remoteJid;
                  const participant = msg.key.participant;
                  const isFromMe = msg.key.fromMe;


                  // tu número (clave para dev)
                  const myNumber = this.sock?.user?.id?.split(':')[0] || null;

                  let realJid = rawJid;
                  // const realJid = rawJid.includes('@lid') ? msg.message?.extendedTextMessage?.contextInfo.participant : rawJid;
                  // const jid = msg.key.remoteJid;
                  // const realJid = msg.key.remoteJid.includes('@lid') ? msg.message?.extendedTextMessage?.contextInfo.participant : msg.key.remoteJid;


                  // === CASO LID ===
                  if(rawJid?.includes('@lid')){
                    const possibleJid = participant || msg.message?.extendedTextMessage?.contextInfo?.participant;

                    // Caso 1: se puede resolver
                    if(possibleJid && !possibleJid.includes('@lid')){
                      realJid = possibleJid;
                    }
                    // Caso 2: eres tú mismo (DEV)
                    else if( IS_DEV && isFromMe && myNumber){
                      logger.warn('LID propio -> usando myNumber (modo dev)');
                      realJid = `${myNumber}@s.whatsapp.net`;
                  }
                  // Caso 3: basura
                  else {
                      logger.warn('Ignorando mensaje LID sin número válido');
                      continue;
                    }
                  }

                  // === EXTRAER MENSAJE ===
                  const messageText = extractMessage(msg);

                  if(!messageText || !realJid) continue;

                  // === VALIDAR JID ===
                 if(!realJid.endsWith('@s.whatsapp.net')){
                   logger.warn('JID inválido para backend', realJid);
                   continue;
                 }
                 logger.info('INCOMING MESSAGE', {
                   rawJid,
                   participant,
                   realJid,
                   messageText
                 });

                  // Enviar al backend (laravel)
                 // await  this.forwardToBackend(jid, messageText);
                 await this.forwardToBackend(realJid, messageText);
                }catch (error){
                  logger.error('Error procesando mensaje entrantes', {
                    error: error.message
                  });
                }
              }
            })

            // se manejan las actualizaciones de conexión
            this.sock.ev.on('connection.update', async (update) => {
                await this.handleConnectionUpdate(update);
            });

            // se guarda las credenciales cuando cambien
            this.sock.ev.on('creds.update', saveCreds);

            this.isInitializing = false;

        } catch (error) {
            this.isInitializing = false;
            logger.error('Error al inicializar WhatsApp', { error: error.message });
            throw error;
        }
    }

    async forwardToBackend(jid, message){
      const phone = jid.split('@')[0];

      logger.info('SENDING TO BACKEND', {
        jid,
        phone,
        message
      });
     try{
       const response = await fetch(API_URL, {
         method: 'POST',
         'headers': {
           'Content-Type': 'application/json'
         },
         body: JSON.stringify({
           // phone: jid,
           phone,
           message
         })
       });
       // const data = await response.json();
       const text = await response.text();
       let data;
       try{
        data = JSON.parse(text);
       }catch {
         logger.error('Respuesta no es JSON', {text: text.slice(0, 200)});
         return;
       }
       logger.info('BACKEND RESPONSE', {
         status: response.status,
         data
       });
       if(data.reply){
         await this.handleBotResponse(jid, data.reply)
       }
     } catch(error){
       // logger.error('Error enviando a backend', {
       //   error: error.message
       // });
       logger.error('SEND MESSAGE ERROR', {
         jid,
         error: error.message,
         stack: error.state
       });
     }
    }
    async handleBotResponse(jid, data){
        const {text, metadata} = data;

        logger.info('SENDING TO WHATSAPP', {
          jid,
          text,
          metadata
        });

        if(text){
          await this.sendMessage(jid, text);
        }

        if(!metadata) return;

        if(metadata.type === 'products'){
            for(const product of metadata.products){
              if(product.image){
                await this.sendTextImage(
                  jid,
                  product.image,
                  `${product.name}\nS/ ${product.price}`
                );
              } else {
                await this.sendMessage(
                  jid,
                  `${product.name}\nS/ ${product.price}`
                );
              }
            }
          }

      }
    /**
     * Maneja actualizaciones de conexión
     */
    async handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;

        // Manejar QR
        if (qr) {
            await this.handleQR(qr);
        }

        // Manejar cambios de conexión
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;

            logger.warn('Conexión cerrada (esto pasa a veces)', {
                reason: lastDisconnect?.error?.message,
                shouldReconnect
            });

            this.isReady = false;
            this.currentQR = null;

            this.emitQRUpdate({
                connectionStatus: 'disconnected',
                qrData: null
            });

            if (shouldReconnect) {
                logger.info('Reconectando...');
                // this.sock = null;
                if(this.sock) {
                 try{
                   this.sock.ev.removeAllListeners();
                   this.sock.ws?.close();
                 } catch(e){}
                }
                this.sock = null
                setTimeout(() => this.initialize(), 3000);
            } else {
                logger.info('Sesión cerrada por el usuario');
                this.sock = null;

                if (fs.existsSync(WHATSAPP_CONFIG.authPath)) {
                    try {
                        const files = fs.readdirSync(WHATSAPP_CONFIG.authPath);
                        for (const file of files) {
                            const filePath = `${WHATSAPP_CONFIG.authPath}/${file}`;
                            fs.rmSync(filePath, { recursive: true, force: true });
                        }
                    } catch (error) {
                        logger.warn('Error al eliminar contenido de auth_info, reintentando...', { error: error.message });
                        await new Promise(resolve => setTimeout(resolve, 1000));

                        const files = fs.readdirSync(WHATSAPP_CONFIG.authPath);
                        for (const file of files) {
                            const filePath = `${WHATSAPP_CONFIG.authPath}/${file}`;
                            fs.rmSync(filePath, { recursive: true, force: true });
                        }
                    }
                }
            }
        } else if (connection === 'open') {
            logger.info('Cliente de WhatsApp listo');
            this.isReady = true;
            this.currentQR = null;
            clearTimeout(this.qrTimeout);

            this.emitQRUpdate({
                connectionStatus: 'connected',
                qrData: null
            });
        }
    }

    /**
     * Maneja la generación de QR
     */
    async handleQR(qr) {
        logger.info('Código QR generado');

        try {
            this.currentQR = await QRCode.toDataURL(qr);

            clearTimeout(this.qrTimeout);
            this.qrTimeout = setTimeout(() => {
                if (!this.isReady) {
                    this.currentQR = null;
                }
            }, WHATSAPP_CONFIG.qrTimeout);

            this.emitQRUpdate({
                qrData: {
                    image: this.currentQR,
                    expiresAt: Date.now() + 60000,
                    createdAt: new Date().toISOString()
                },
                connectionStatus: 'qr-ready'
            });
        } catch (error) {
            logger.error('Error al generar código QR', { error: error.message });
        }
    }

    /**
     * Valida si un número está registrado en WhatsApp
     */
    async validateNumber(numberId, skipValidation = false, chatId = null) {
        if (!this.isReady || !this.sock) {
            throw new Error('WhatsApp no está conectado');
        }

        if (skipValidation && chatId) {
            return chatId;
        }

        try {
            const [result] = await this.sock.onWhatsApp(numberId);

            if (result && result.exists) {
                return result.jid;
            }

            return null;
        } catch (error) {
            logger.error('Error al validar número', { error: error.message, numberId });
            return null;
        }
    }

    /**
     * Envía un mensaje de texto
     */
    async sendMessage(jid, message) {
        if (!this.isReady || !this.sock) {
            throw new Error('WhatsApp no está conectado');
        }

        try {
            const result = await this.sock.sendMessage(jid, { text: message });

            logger.info('Mensaje enviado', { jid });
            return {
                success: true,
                messageId: result.key.id,
                chatId: jid,
                timestamp: result.messageTimestamp
            };
        } catch (error) {
            logger.error('Error al enviar mensaje', { error: error.message, jid });
            throw error;
        }
    }

    /**
     * Envía una imagen con caption (texto)
     */
    async sendTextImage(jid, imageBuffer, caption = '') {
        if (!this.isReady || !this.sock) {
            throw new Error('WhatsApp no está conectado');
        }

        try {
            const message = {
                image: imageBuffer,
                caption: caption || undefined
            };

            const result = await this.sock.sendMessage(jid, message);

            logger.info('Mensaje enviado', { jid });
            return {
                success: true,
                messageId: result.key.id,
                chatId: jid,
                timestamp: result.messageTimestamp
            };
        } catch (error) {
            logger.error('Error al enviar imagen', { error: error.message, jid });
            throw error;
        }
    }

    /**
     * Reinicia la sesión de WhatsApp
     */
    async resetSession() {
        try {
            if (this.isInitializing) {
                throw new Error('Ya hay una operación en progreso');
            }

            this.isInitializing = true;

            await this.destroy(); // destruir recursos y cliente existente

            this.emitQRUpdate({
                connectionStatus: 'disconnected',
                qrData: null
            });

            // Esperar antes de eliminar archivos
            await new Promise(resolve => setTimeout(resolve, 1000));

            if (fs.existsSync(WHATSAPP_CONFIG.authPath)) {
                try {
                    const files = fs.readdirSync(WHATSAPP_CONFIG.authPath);
                    for (const file of files) {
                        const filePath = `${WHATSAPP_CONFIG.authPath}/${file}`;
                        fs.rmSync(filePath, { recursive: true, force: true });
                    }
                } catch (error) {
                    logger.warn('Error al eliminar contenido de auth_info, reintentando...', { error: error.message });
                    await new Promise(resolve => setTimeout(resolve, 1000));

                    const files = fs.readdirSync(WHATSAPP_CONFIG.authPath);
                    for (const file of files) {
                        const filePath = `${WHATSAPP_CONFIG.authPath}/${file}`;
                        fs.rmSync(filePath, { recursive: true, force: true });
                    }
                }
            }

            this.isInitializing = false;

            logger.info('Sesión reseteada exitosamente');

            return true;
        } catch (error) {
            this.isInitializing = false;
            logger.error('Error al resetear sesión', { error: error.message });

            // Intentar inicializar
            try {
                await this.initialize();
            } catch (initError) {
                logger.error('Error al reinicializar después de fallo', { error: initError.message });
            }

            throw error;
        }
    }

    /**
     * Destruye el cliente y limpia recursos
     */
    async destroy() {
        if (this.sock) {
            this.sock.ev.removeAllListeners();
            // await this.sock.logout();
            this.sock.ws?.close(); // Solo cerrar conexión
            this.sock = null;
        }
        this.isReady = false;
        this.currentQR = null;
        clearTimeout(this.qrTimeout);
    }

    /**
     * Obtiene el estado actual
     */
    getStatus() {
        return {
            isConnected: this.isReady,
            hasActiveQR: !!this.currentQR,
            qrData: this.currentQR ? {
                image: this.currentQR,
                expiresAt: Date.now() + 60000
            } : null,
            connectionStatus: this.isReady ? 'connected' : (this.currentQR ? 'qr-ready' : 'disconnected')
        };
    }
}

export default new WhatsAppService();
