import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import http from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import OpenAI from 'openai';
import QRCode from 'qrcode';
import pino from 'pino';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Workspace, User, Product, Faq, Order, Conversation, Message, Integration, DocumentTemplate, WhatsappSession, PlatformConfig } from './models.js';

const app = express();
const server = http.createServer(app);
const port = Number(process.env.API_PORT || process.env.PORT || 5050);
const jwtSecret = process.env.JWT_SECRET;
const isProduction = process.env.NODE_ENV === 'production';
if(isProduction && (!jwtSecret || jwtSecret.length < 32)) throw new Error('JWT_SECRET must be at least 32 characters in production');
if(!isProduction && (!jwtSecret || jwtSecret.length < 32)) console.warn('WARNING: JWT_SECRET should be at least 32 characters in production.');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const sessions = new Map();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessionRoot = path.resolve(__dirname, '..', process.env.SESSION_DATA_DIR || 'data/sessions');
const allowedOrigins = (process.env.WEB_ORIGIN || 'http://localhost:5173').split(',').map(x => x.trim()).filter(Boolean);
const io = new Server(server, { cors: { origin: allowedOrigins, credentials: true } });

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin(origin, cb) { if (!origin || allowedOrigins.includes(origin)) return cb(null, true); cb(new Error('Origin not allowed')); }, credentials: true }));
app.use(express.json({limit:'2mb',verify:(req,_res,buf)=>{req.rawBody=buf;}}));
app.use(rateLimit({windowMs:60*1000,max:Number(process.env.API_RATE_LIMIT||600),standardHeaders:true,legacyHeaders:false,skip:req=>req.path==='/health'||req.path==='/ready'}));
app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));

const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const oid = value => new mongoose.Types.ObjectId(String(value));
const id = doc => String(doc?._id || doc?.id || '');
function tokenFor(user){ return jwt.sign({ id:id(user), role:user.role, workspaceId:user.workspaceId ? String(user.workspaceId) : null }, jwtSecret || 'development-only-secret-change-me-123456789', { expiresIn:'7d', issuer:'whatsapp-agent-platform' }); }
function auth(req,res,next){ try { const raw=req.headers.authorization?.replace(/^Bearer\s+/i,''); if(!raw)return res.status(401).json({error:'Unauthorized'}); req.user=jwt.verify(raw,jwtSecret || 'development-only-secret-change-me-123456789'); next(); } catch { return res.status(401).json({error:'Unauthorized'}); } }
function ownerOnly(req,res,next){ if(!['OWNER','STAFF'].includes(req.user.role))return res.status(403).json({error:'Owner access required'}); next(); }
function superOnly(req,res,next){ if(req.user.role!=='SUPERADMIN')return res.status(403).json({error:'Superadmin access required'}); next(); }
function wsId(req){ return oid(req.user.workspaceId); }
function publicUser(u){ return {id:id(u),email:u.email,displayName:u.displayName,role:u.role,workspaceId:u.workspaceId?String(u.workspaceId):null}; }
function verifyMetaSignature(req,res,next){const secret=process.env.META_APP_SECRET;if(!secret){if(isProduction)return res.status(503).json({error:'META_APP_SECRET is not configured'});return next();}const supplied=String(req.headers['x-hub-signature-256']||'');const expected='sha256='+crypto.createHmac('sha256',secret).update(req.rawBody||Buffer.alloc(0)).digest('hex');const a=Buffer.from(supplied),b=Buffer.from(expected);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.sendStatus(401);next();}

app.get('/health',(_req,res)=>res.json({ok:true,time:new Date().toISOString()}));
app.get('/ready',asyncRoute(async(_req,res)=>{const db=mongoose.connection.readyState===1;res.status(db?200:503).json({ok:db,database:db?'connected':'disconnected',time:new Date().toISOString()});}));
app.post('/auth/login', asyncRoute(async(req,res)=>{ const email=String(req.body?.email||'').trim().toLowerCase(); const password=String(req.body?.password||''); const user=await User.findOne({email,active:true}); if(!user || !(await bcrypt.compare(password,user.passwordHash)))return res.status(401).json({error:'Invalid credentials'}); res.json({token:tokenFor(user),user:publicUser(user)}); }));
app.get('/auth/me',auth,asyncRoute(async(req,res)=>{ const u=await User.findById(req.user.id); if(!u)return res.status(404).json({error:'User not found'}); res.json(publicUser(u)); }));

app.get('/dashboard',auth,ownerOnly,asyncRoute(async(req,res)=>{ const workspaceId=wsId(req); const [orders,totalConversations,totalProducts]=await Promise.all([Order.find({workspaceId}).select('total status').lean(),Conversation.countDocuments({workspaceId}),Product.countDocuments({workspaceId})]); const totalRevenue=orders.filter(o=>o.status==='DELIVERED').reduce((s,o)=>s+Number(o.total||0),0); res.json({totalOrders:orders.length,totalConversations,totalRevenue,totalProducts}); }));

app.get('/products',auth,ownerOnly,asyncRoute(async(req,res)=>res.json(await Product.find({workspaceId:wsId(req)}).sort({createdAt:-1}))));
app.post('/products',auth,ownerOnly,asyncRoute(async(req,res)=>{ const b=req.body||{}; const p=await Product.create({workspaceId:wsId(req),name:b.name,sku:b.sku||undefined,description:b.description||'',category:b.category||'',price:Number(b.price||0),stock:Number(b.stock||0),active:b.active!==false,externalId:b.externalId||undefined}); res.status(201).json(p); }));
app.put('/products/:id',auth,ownerOnly,asyncRoute(async(req,res)=>{ const b=req.body||{}; const p=await Product.findOneAndUpdate({_id:req.params.id,workspaceId:wsId(req)},{$set:{name:b.name,sku:b.sku||undefined,description:b.description||'',category:b.category||'',price:Number(b.price||0),stock:Number(b.stock||0),active:b.active!==false,externalId:b.externalId||undefined}},{new:true,runValidators:true}); if(!p)return res.status(404).json({error:'Not found'}); res.json(p); }));
app.delete('/products/:id',auth,ownerOnly,asyncRoute(async(req,res)=>{ await Product.deleteOne({_id:req.params.id,workspaceId:wsId(req)}); res.json({ok:true}); }));

app.get('/faqs',auth,ownerOnly,asyncRoute(async(req,res)=>res.json(await Faq.find({workspaceId:wsId(req)}).sort({createdAt:-1}))));
app.post('/faqs',auth,ownerOnly,asyncRoute(async(req,res)=>{ const b=req.body||{}; res.status(201).json(await Faq.create({workspaceId:wsId(req),question:b.question,answer:b.answer,productId:b.productId||null,active:b.active!==false})); }));
app.put('/faqs/:id',auth,ownerOnly,asyncRoute(async(req,res)=>{ const f=await Faq.findOneAndUpdate({_id:req.params.id,workspaceId:wsId(req)},{$set:{question:req.body.question,answer:req.body.answer,productId:req.body.productId||null,active:req.body.active!==false}},{new:true,runValidators:true}); if(!f)return res.status(404).json({error:'Not found'}); res.json(f); }));
app.delete('/faqs/:id',auth,ownerOnly,asyncRoute(async(req,res)=>{ await Faq.deleteOne({_id:req.params.id,workspaceId:wsId(req)});res.json({ok:true}); }));

app.get('/orders',auth,ownerOnly,asyncRoute(async(req,res)=>res.json(await Order.find({workspaceId:wsId(req)}).sort({createdAt:-1}))));
app.post('/orders',auth,ownerOnly,asyncRoute(async(req,res)=>{ const b=req.body||{}; const total=Number(b.total??b.subtotal??0); const o=await Order.create({workspaceId:wsId(req),customerName:b.customerName,customerPhone:b.customerPhone,address:b.address||'',notes:b.notes||'',items:b.items||[],subtotal:Number(b.subtotal??total),total,status:b.status||'PENDING',source:b.source||'manual'}); res.status(201).json(o); }));
app.patch('/orders/:id/status',auth,ownerOnly,asyncRoute(async(req,res)=>{ const allowed=['PENDING','CONFIRMED','PREPARING','SHIPPED','DELIVERED','CANCELLED']; if(!allowed.includes(req.body.status))return res.status(400).json({error:'Invalid status'}); const o=await Order.findOneAndUpdate({_id:req.params.id,workspaceId:wsId(req)},{$set:{status:req.body.status}},{new:true}); if(!o)return res.status(404).json({error:'Not found'});res.json(o); }));

app.get('/conversations',auth,ownerOnly,asyncRoute(async(req,res)=>{ const rows=await Conversation.find({workspaceId:wsId(req)}).sort({updatedAt:-1}); const result=await Promise.all(rows.map(async c=>{const last=await Message.findOne({conversationId:c._id}).sort({createdAt:-1}); const out=c.toJSON(); out.messages=last?[last]:[]; return out;})); res.json(result); }));
app.get('/conversations/:id/messages',auth,ownerOnly,asyncRoute(async(req,res)=>{ const c=await Conversation.findOne({_id:req.params.id,workspaceId:wsId(req)}); if(!c)return res.status(404).json({error:'Not found'}); await Conversation.updateOne({_id:c._id},{$set:{unreadCount:0}}); res.json(await Message.find({conversationId:c._id}).sort({createdAt:1})); }));
app.post('/conversations/:id/send',auth,ownerOnly,asyncRoute(async(req,res)=>{ const c=await Conversation.findOne({_id:req.params.id,workspaceId:wsId(req)});if(!c)return res.status(404).json({error:'Not found'}); const body=String(req.body?.body||'').trim();if(!body)return res.status(400).json({error:'Message is required'}); await sendWhatsapp(wsId(req),c.whatsappJid||c.phone,body); const msg=await Message.create({conversationId:c._id,direction:'out',body}); await Conversation.updateOne({_id:c._id},{$set:{updatedAt:new Date()}}); io.to(`ws:${req.user.workspaceId}`).emit('message',msg);res.json(msg); }));
app.patch('/conversations/:id/handoff',auth,ownerOnly,asyncRoute(async(req,res)=>{ const humanHandoff=Boolean(req.body.humanHandoff); const c=await Conversation.findOneAndUpdate({_id:req.params.id,workspaceId:wsId(req)},{$set:{humanHandoff,status:humanHandoff?'HUMAN':'OPEN'}},{new:true});if(!c)return res.status(404).json({error:'Not found'});res.json(c); }));

app.get('/settings',auth,ownerOnly,asyncRoute(async(req,res)=>{ const w=await Workspace.findById(wsId(req));if(!w)return res.status(404).json({error:'Workspace not found'});res.json(w); }));
app.get('/billing',auth,ownerOnly,asyncRoute(async(req,res)=>{const w=await Workspace.findById(wsId(req)).lean();if(!w)return res.status(404).json({error:'Workspace not found'});const conversations=await Conversation.countDocuments({workspaceId:w._id});res.json({plan:w.plan,conversationUsage:conversations,conversationLimit:w.conversationLimit,aiActionUsage:w.aiActionUsage||0,aiActionLimit:w.aiActionLimit,nextBilling:'Monthly'});}));
app.put('/settings',auth,ownerOnly,asyncRoute(async(req,res)=>{ const allowed=['name','currency','defaultLanguage','systemPrompt','capabilities','businessInfo','welcomeSequence','paymentMethods','collectionFields','followupSettings','notificationSettings']; const data={};for(const k of allowed)if(k in (req.body||{}))data[k]=req.body[k]; const w=await Workspace.findByIdAndUpdate(wsId(req),{$set:data},{new:true,runValidators:true});res.json(w); }));
app.post('/settings/reconfigure',auth,ownerOnly,asyncRoute(async(req,res)=>{ const workspaceId=wsId(req); await Promise.all([Product.deleteMany({workspaceId}),Faq.deleteMany({workspaceId}),DocumentTemplate.deleteMany({workspaceId}),Integration.deleteMany({workspaceId})]); await Workspace.updateOne({_id:workspaceId},{$set:{welcomeSequence:[],paymentMethods:[],collectionFields:[],followupSettings:{},notificationSettings:{},defaultLanguage:'auto'}});res.json({ok:true}); }));

app.get('/integrations',auth,ownerOnly,asyncRoute(async(req,res)=>res.json(await Integration.find({workspaceId:wsId(req)}).sort({createdAt:-1}))));
app.post('/integrations',auth,ownerOnly,asyncRoute(async(req,res)=>{ const b=req.body||{}; const row=await Integration.create({workspaceId:wsId(req),type:b.type,name:b.name,baseUrl:b.baseUrl||'',apiKeyEncrypted:b.apiKey||'',config:b.config||{},active:b.active!==false});res.status(201).json(row); }));
app.delete('/integrations/:id',auth,ownerOnly,asyncRoute(async(req,res)=>{await Integration.deleteOne({_id:req.params.id,workspaceId:wsId(req)});res.json({ok:true});}));

app.get('/templates',auth,ownerOnly,asyncRoute(async(req,res)=>res.json(await DocumentTemplate.find({workspaceId:wsId(req)}).sort({createdAt:-1}))));
app.post('/templates',auth,ownerOnly,asyncRoute(async(req,res)=>{const b=req.body||{};res.status(201).json(await DocumentTemplate.create({workspaceId:wsId(req),name:b.name,type:b.type||'invoice',template:b.template||{}}));}));
app.delete('/templates/:id',auth,ownerOnly,asyncRoute(async(req,res)=>{await DocumentTemplate.deleteOne({_id:req.params.id,workspaceId:wsId(req)});res.json({ok:true});}));

app.get('/whatsapp/sessions',auth,ownerOnly,asyncRoute(async(req,res)=>{ const rows=await WhatsappSession.find({workspaceId:wsId(req)}).sort({createdAt:-1}); res.json(rows.map(s=>{const x=s.toJSON(); if(x.metaAccessToken)x.metaAccessToken='••••••••'; return x;})); }));
app.post('/whatsapp/sessions',auth,ownerOnly,asyncRoute(async(req,res)=>{ const b=req.body||{}; const s=await WhatsappSession.create({workspaceId:wsId(req),name:b.name||'My Business WhatsApp',mode:b.mode||'QR',status:'pending',metaPhoneNumberId:b.metaPhoneNumberId||undefined,metaBusinessAccountId:b.metaBusinessAccountId||undefined,metaAccessToken:b.metaAccessToken||undefined,metaVerifyToken:b.metaVerifyToken||undefined});res.status(201).json(s); }));
app.post('/whatsapp/sessions/:id/connect',auth,ownerOnly,asyncRoute(async(req,res)=>{const s=await WhatsappSession.findOne({_id:req.params.id,workspaceId:wsId(req)});if(!s)return res.status(404).json({error:'Not found'});if(s.mode!=='QR')return res.status(400).json({error:'META sessions connect through webhook configuration'});await startQrSession(s);res.json({ok:true,status:'starting'});}));
app.get('/whatsapp/sessions/:id/qr',auth,ownerOnly,asyncRoute(async(req,res)=>{ const s=await WhatsappSession.findOne({_id:req.params.id,workspaceId:wsId(req)});if(!s)return res.status(404).json({error:'Not found'});const state=sessions.get(String(s._id));res.json({qr:state?.qr||null,status:state?.status||s.status||'pending',phone:s.phone||null}); }));
app.delete('/whatsapp/sessions/:id',auth,ownerOnly,asyncRoute(async(req,res)=>{const s=await WhatsappSession.findOne({_id:req.params.id,workspaceId:wsId(req)});if(!s)return res.json({ok:true});const key=String(s._id),st=sessions.get(key);if(st)st.stopping=true;try{await st?.sock?.logout();}catch{}sessions.delete(key);await WhatsappSession.deleteOne({_id:s._id});await fs.rm(path.join(sessionRoot,key),{recursive:true,force:true});res.json({ok:true});}));

app.get('/meta/webhook',asyncRoute(async(req,res)=>{ const token=req.query['hub.verify_token']; const session=await WhatsappSession.findOne({mode:'META',metaVerifyToken:token}); if(req.query['hub.mode']==='subscribe' && (token===process.env.META_VERIFY_TOKEN || session))return res.status(200).send(req.query['hub.challenge']);res.sendStatus(403); }));
app.post('/meta/webhook',verifyMetaSignature,asyncRoute(async(req,res)=>{res.sendStatus(200);const entries=req.body?.entry||[];for(const e of entries)for(const c of e.changes||[])for(const m of c.value?.messages||[]){const phoneNumberId=c.value?.metadata?.phone_number_id;const session=await WhatsappSession.findOne({mode:'META',metaPhoneNumberId:phoneNumberId,status:'connected'});if(session&&m.type==='text')await handleIncoming(session.workspaceId,m.from,m.text?.body||'',m.id,async text=>sendMeta(session,m.from,text));}}));

app.get('/admin/overview',auth,superOnly,asyncRoute(async(_req,res)=>{const [users,workspaces,orders,conversations]=await Promise.all([User.countDocuments(),Workspace.countDocuments(),Order.countDocuments(),Conversation.countDocuments()]);res.json({users,workspaces,orders,conversations});}));
app.get('/admin/workspaces',auth,superOnly,asyncRoute(async(_req,res)=>{const rows=await Workspace.find().sort({createdAt:-1});const result=await Promise.all(rows.map(async w=>{const [users,products,orders,conversations]=await Promise.all([User.find({workspaceId:w._id}).select('email displayName role'),Product.countDocuments({workspaceId:w._id}),Order.countDocuments({workspaceId:w._id}),Conversation.countDocuments({workspaceId:w._id})]);return {...w.toJSON(),users,_count:{products,orders,conversations}};}));res.json(result);}));
app.post('/admin/workspaces',auth,superOnly,asyncRoute(async(req,res)=>{const b=req.body||{};if(!b.name||!b.slug||!b.email)return res.status(400).json({error:'name, slug and email are required'});const existing=await User.findOne({email:String(b.email).toLowerCase()});if(existing)return res.status(409).json({error:'Email already exists'});const hash=await bcrypt.hash(b.password||'Admin@123456',12);const w=await Workspace.create({name:b.name,slug:b.slug,currency:b.currency||'LKR'});try{const u=await User.create({email:String(b.email).toLowerCase(),passwordHash:hash,displayName:b.displayName||b.email,role:'OWNER',workspaceId:w._id});res.status(201).json({workspace:w,user:publicUser(u)});}catch(err){await Workspace.deleteOne({_id:w._id});throw err;}}));
app.patch('/admin/workspaces/:id/plan',auth,superOnly,asyncRoute(async(req,res)=>{const w=await Workspace.findByIdAndUpdate(req.params.id,{$set:{plan:req.body.plan,conversationLimit:Number(req.body.conversationLimit||20),aiActionLimit:Number(req.body.aiActionLimit||50)}},{new:true});if(!w)return res.status(404).json({error:'Not found'});res.json(w);}));
app.get('/admin/config',auth,superOnly,asyncRoute(async(_req,res)=>{let c=await PlatformConfig.findOne({key:'default'});if(!c)c=await PlatformConfig.create({key:'default'});const out=c.toJSON();if(out.ai?.apiKey)out.ai.apiKey='••••••••';res.json(out);}));
app.put('/admin/config',auth,superOnly,asyncRoute(async(req,res)=>{const b=req.body||{};const allowed={};if(b.ai){const current=await PlatformConfig.findOne({key:'default'}).lean();const incomingKey=String(b.ai.apiKey||'').trim();allowed.ai={provider:b.ai.provider||'openai',model:b.ai.model||'gpt-5-mini',baseURL:b.ai.baseURL||'',apiKey:incomingKey&&!/^•+$/.test(incomingKey)?incomingKey:(current?.ai?.apiKey||''),apiKeyConfigured:Boolean(incomingKey||current?.ai?.apiKey)};}if(Array.isArray(b.plans))allowed.plans=b.plans;if(b.settings)allowed.settings=b.settings;const c=await PlatformConfig.findOneAndUpdate({key:'default'},{$set:allowed}, {new:true,upsert:true,setDefaultsOnInsert:true});const out=c.toJSON();if(out.ai?.apiKey)out.ai.apiKey='••••••••';res.json(out);}));
app.get('/admin/health',auth,superOnly,asyncRoute(async(_req,res)=>{res.json({api:'online',database:mongoose.connection.readyState===1?'connected':'disconnected',openai:Boolean(process.env.OPENAI_API_KEY),whatsappSessions:await WhatsappSession.countDocuments({status:'connected'}),time:new Date().toISOString()});}));

io.use((socket,next)=>{try{const t=socket.handshake.auth?.token;socket.user=jwt.verify(t,jwtSecret || 'development-only-secret-change-me-123456789');next();}catch{next(new Error('Unauthorized'));}});
io.on('connection',socket=>{if(socket.user.workspaceId)socket.join(`ws:${socket.user.workspaceId}`);});

async function startQrSession(session){
  const key=String(session._id||session.id); const existing=sessions.get(key); if(existing?.starting||existing?.reconnecting||existing?.status==='connected'){console.log(`[WA ${key}] start skipped; session already ${existing.status||'starting'}`);return;} console.log(`[WA ${key}] starting QR session for workspace ${session.workspaceId}`); await fs.mkdir(path.join(sessionRoot,key),{recursive:true});
  // WhatsApp permits only one active Web session for this workspace/account.
  // Close any older in-process session before opening this one to prevent
  // "Stream Errored (conflict)" and missed incoming messages.
  for(const [otherKey,other] of sessions){
    if(otherKey!==key && other.workspaceId===String(session.workspaceId)){
      console.log(`[WA ${key}] closing conflicting session ${otherKey}`);
      other.stopping=true;
      try{other.sock?.end?.(new Error('Replaced by newer session'));}catch{}
      sessions.delete(otherKey);
      await WhatsappSession.updateOne({_id:otherKey},{$set:{status:'disconnected'}}).catch(()=>{});
    }
  }
  const {state,saveCreds}=await useMultiFileAuthState(path.join(sessionRoot,key)); const {version}=await fetchLatestBaileysVersion();
  const sock=makeWASocket({version,auth:state,logger:pino({level:'silent'}),printQRInTerminal:false,browser:['WhatsApp Agent Platform','Chrome','1.0.0'],syncFullHistory:false,markOnlineOnConnect:false});
  const st={sock,qr:null,status:'starting',starting:true,workspaceId:String(session.workspaceId)};sessions.set(key,st);sock.ev.on('creds.update',saveCreds);
  sock.ev.on('connection.update',async update=>{
    console.log(`[WA ${key}] connection update`,JSON.stringify({connection:update.connection,hasQr:Boolean(update.qr),lastDisconnect:update.lastDisconnect?.error?.message||null}));
    if(update.qr){st.qr=await QRCode.toDataURL(update.qr);st.status='qr';st.starting=false;sessions.set(key,st);await WhatsappSession.updateOne({_id:key},{$set:{status:'qr'}});io.to(`ws:${session.workspaceId}`).emit('whatsapp',{sessionId:key,status:'qr'});}
    if(update.connection==='open'){st.status='connected';st.qr=null;st.starting=false;sessions.set(key,st);const phone=sock.user?.id?.split(':')[0]||null;console.log(`[WA ${key}] CONNECTED as ${phone||'unknown phone'}; message listener active`);await WhatsappSession.updateOne({_id:key},{$set:{status:'connected',phone}});io.to(`ws:${session.workspaceId}`).emit('whatsapp',{sessionId:key,status:'connected',phone});}
    if(update.connection==='close'){const code=update.lastDisconnect?.error?.output?.statusCode;const loggedOut=code===DisconnectReason.loggedOut;st.status=loggedOut?'logged_out':'disconnected';st.starting=false;st.reconnecting=!loggedOut&&!st.stopping;sessions.set(key,st);await WhatsappSession.updateOne({_id:key},{$set:{status:st.status}}).catch(()=>{});if(st.reconnecting)setTimeout(()=>{if(!st.stopping){st.reconnecting=false;startQrSession(session).catch(err=>logger.warn({err},'reconnect failed'));}},3000);}
  });
  sock.ev.on('messages.upsert',async({messages,type})=>{console.log(`[WA ${key}] messages.upsert type=${type} count=${messages?.length||0}`);for(const m of messages){try{if(m.key.fromMe){console.log(`[WA ${key}] ignored outgoing message ${m.key.id}`);continue;}if(!m.message){console.log(`[WA ${key}] ignored message without payload ${m.key.id}`);continue;}const jid=m.key.remoteJid;const altJid=m.key.remoteJidAlt||m.key.senderPn||m.key.participant||null;const routeJid=jid||altJid;if(!routeJid||(!routeJid.endsWith('@s.whatsapp.net')&&!routeJid.endsWith('@lid'))){console.log(`[WA ${key}] ignored jid=${jid} alt=${altJid||''} key=${JSON.stringify(m.key)}`);continue;}const displayJid=altJid&&altJid.endsWith('@s.whatsapp.net')?altJid:routeJid;const phone=displayJid.replace(/@(s\.whatsapp\.net|lid)$/,'');const text=m.message.conversation||m.message.extendedTextMessage?.text||m.message.imageMessage?.caption||m.message.videoMessage?.caption||'';if(!text){console.log(`[WA ${key}] ignored non-text message keys=${Object.keys(m.message).join(',')}`);continue;}console.log(`[WA ${key}] RECEIVED from=${phone} route=${routeJid} display=${displayJid} text=${JSON.stringify(text)}`);await handleIncoming(session.workspaceId,phone,text,m.key.id,async reply=>sock.sendMessage(routeJid,{text:reply}),routeJid);console.log(`[WA ${key}] STORED message ${m.key.id}`);}catch(err){console.error(`[WA ${key}] PROCESSING ERROR`,err);}}});
}

async function sendWhatsapp(workspaceId,phone,text){
  const workspaceKey=String(workspaceId);
  // The live socket is authoritative. MongoDB status can briefly be stale
  // during reconnects or node --watch restarts.
  const jid=String(phone).includes('@')?String(phone):`${String(phone).replace(/\D/g,'')}@s.whatsapp.net`;
  for(const st of sessions.values()){
    if(st.workspaceId===workspaceKey && st.sock) return st.sock.sendMessage(jid,{text});
  }
  const db=await WhatsappSession.findOne({workspaceId,status:'connected'}).sort({createdAt:-1});
  if(!db)throw new Error('No connected WhatsApp session');
  if(db.mode==='META')return sendMeta(db,phone,text);
  const st=sessions.get(String(db._id));
  if(!st?.sock)throw new Error('QR session is not active on this server process');
  return st.sock.sendMessage(jid,{text});
}
async function sendMeta(session,phone,text){if(!session.metaAccessToken||!session.metaPhoneNumberId)throw new Error('Meta credentials missing');const graphVersion=process.env.META_GRAPH_VERSION||'v23.0';const r=await fetch(`https://graph.facebook.com/${graphVersion}/${session.metaPhoneNumberId}/messages`,{method:'POST',headers:{Authorization:`Bearer ${session.metaAccessToken}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:phone,type:'text',text:{body:text}})});if(!r.ok)throw new Error(`Meta send failed ${r.status}: ${await r.text()}`);return r.json();}

async function handleIncoming(workspaceIdRaw,phone,text,externalId,sendReply,remoteJid){const workspaceId=oid(workspaceIdRaw);const duplicate=await Message.findOne({externalId}).catch(()=>null);if(duplicate){console.log(`[WA] duplicate message ignored externalId=`);return;}console.log(`[WA] saving incoming workspace=${workspaceId} phone=${phone} externalId=${externalId}`);let c=await Conversation.findOneAndUpdate({workspaceId,phone},{$setOnInsert:{workspaceId,phone,customerName:phone},$set:{updatedAt:new Date(),whatsappJid:remoteJid||`${phone}@s.whatsapp.net`},$inc:{unreadCount:1}},{new:true,upsert:true});const incoming=await Message.create({conversationId:c._id,direction:'in',body:text,externalId});console.log(`[WA] saved incoming conversation=${c._id} message=${incoming._id}`);io.to(`ws:${String(workspaceId)}`).emit('message',incoming);if(c.humanHandoff)return;if(/\b(human|agent|person|staff)\b/i.test(text)||/මනුෂ්‍ය|කෙනෙක්|ස්ටාෆ್/.test(text)){c=await Conversation.findByIdAndUpdate(c._id,{$set:{humanHandoff:true,status:'HUMAN'}},{new:true});const reply='Sure — I’ll hand this over to a human team member. / හරි, මම ඔබව අපගේ කාර්ය මණ්ඩලයට යොමු කරන්නම්.';await storeAndSend(c._id,workspaceId,reply,sendReply);return;}const reply=await runAgent(workspaceId,c._id,text);await storeAndSend(c._id,workspaceId,reply,sendReply);}
async function storeAndSend(conversationId,workspaceId,reply,sendReply){const out=await Message.create({conversationId,direction:'out',body:reply});await sendReply(reply);await Conversation.updateOne({_id:conversationId},{$set:{updatedAt:new Date()}});io.to(`ws:${String(workspaceId)}`).emit('message',out);}

async function getConfiguredAiClient(){const c=await PlatformConfig.findOne({key:'default'}).lean().catch(()=>null);const ai=c?.ai;const apiKey=String(ai?.apiKey||process.env.OPENAI_API_KEY||'').trim();if(!apiKey)return null;const inferredOpenRouter=apiKey.startsWith('sk-or-');const provider=String(ai?.provider||'openai').toLowerCase();const useOpenRouter=provider==='openrouter'||inferredOpenRouter;const useGemini=provider==='gemini';const baseURL=ai?.baseURL|| (useOpenRouter?'https://openrouter.ai/api/v1':useGemini?'https://generativelanguage.googleapis.com/v1beta/openai/':undefined);const configuredModel=String(ai?.model||'').trim();const model=useOpenRouter&&(!configuredModel||configuredModel==='gpt-5-mini')?'openai/gpt-4o-mini':useGemini&&(!configuredModel||configuredModel==='gpt-5-mini'||configuredModel==='gemini-2.0-flash'||configuredModel==='gemini-2.5-flash')?'gemini-3.6-flash':configuredModel||process.env.OPENAI_MODEL||'gpt-5-mini';console.log(`[AI] provider=${provider} model=${model} baseURL=${baseURL||'default'}`);return {client:new OpenAI({apiKey,baseURL,defaultHeaders:useOpenRouter?{'HTTP-Referer':'http://localhost:5173','X-Title':'WhatsApp Agent Platform'}:undefined}),model,provider};}

async function runAgent(workspaceId,conversationId,userText){
  const w=await Workspace.findById(workspaceId);const [dbProducts,faqs,history]=await Promise.all([Product.find({workspaceId,active:true}).limit(100).lean(),Faq.find({workspaceId,active:true}).limit(100).lean(),Message.find({conversationId}).sort({createdAt:-1}).limit(12).lean()]);
  const products=await getLiveProducts(workspaceId,userText,dbProducts);const fallback=()=>{const q=userText.toLowerCase();const hits=products.filter(p=>String(p.name).toLowerCase().includes(q)||q.split(/\s+/).some(x=>x.length>3&&String(p.name).toLowerCase().includes(x))).slice(0,3);if(hits.length)return hits.map(p=>`${p.name} — ${w.currency} ${Number(p.price).toFixed(2)} — ${Number(p.stock)>0?`${p.stock} in stock`:'out of stock'}`).join('\n');const f=faqs.find(x=>q.includes(String(x.question).toLowerCase().slice(0,12)));return f?.answer||"Thanks! I’ve received your message. A team member can help if you need anything specific.";};
  if(Number(w.aiActionUsage||0)>=Number(w.aiActionLimit||0))return 'Your plan’s AI action limit has been reached. A team member will follow up shortly.';
  const aiClient=await getConfiguredAiClient();
  if(!aiClient)return fallback();
  const context=`Business: ${w.name}\nCurrency: ${w.currency}\nBusiness info: ${JSON.stringify(w.businessInfo||{})}\nProducts: ${products.map(p=>`${p.name}|SKU:${p.sku||'-'}|${w.currency} ${p.price}|stock:${p.stock}`).join('\n')}\nFAQs: ${faqs.map(f=>`${f.question} => ${f.answer}`).join('\n')}`;
  try{await Workspace.updateOne({_id:workspaceId},{$inc:{aiActionUsage:1}});const messages=[{role:'system',content:`${w.systemPrompt}\nNever invent price or stock. Use only supplied live context. If information is missing, ask one short question at a time. Create an order only when product, quantity, customer name, phone, and address are known. If uncertain, offer human handoff. Match the customer's language. Keep replies concise.\n${context}`},...history.reverse().map(m=>({role:m.direction==='in'?'user':'assistant',content:m.body}))];
    const tools=[{type:'function',function:{name:'create_order',description:'Create a confirmed customer order after all required details are collected.',parameters:{type:'object',properties:{customerName:{type:'string'},customerPhone:{type:'string'},address:{type:'string'},notes:{type:'string'},items:{type:'array',items:{type:'object',properties:{productName:{type:'string'},sku:{type:'string'},quantity:{type:'integer',minimum:1}},required:['productName','quantity']}}},required:['customerName','customerPhone','address','items']}}}];
    const completionOptions={model:aiClient.model,messages,temperature:0.2,max_tokens:350,...(aiClient.provider==='gemini'?{}:{tools,tool_choice:'auto'})};let completion=await aiClient.client.chat.completions.create(completionOptions);let assistant=completion.choices?.[0]?.message;
    if(assistant?.tool_calls?.length){messages.push(assistant);for(const tc of assistant.tool_calls){if(tc.function.name!=='create_order')continue;let args={};try{args=JSON.parse(tc.function.arguments||'{}')}catch{}const result=await createOrderFromAgent(workspaceId,args,products);messages.push({role:'tool',tool_call_id:tc.id,content:JSON.stringify(result)});}completion=await aiClient.client.chat.completions.create({model:aiClient.model,messages,temperature:0.2,max_tokens:300});assistant=completion.choices?.[0]?.message;}
    return assistant?.content?.trim()||fallback();
  }catch(err){logger.error({err},'agent error');return fallback();}
}

async function getLiveProducts(workspaceId,query,dbProducts){const integration=await Integration.findOne({workspaceId,type:'custom_api',active:true}).lean();if(!integration?.baseUrl)return dbProducts;try{const url=new URL('/products/search',integration.baseUrl);url.searchParams.set('q',query||'');const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),5000);const r=await fetch(url,{headers:{Accept:'application/json',...(integration.apiKeyEncrypted?{Authorization:`Bearer ${integration.apiKeyEncrypted}`}:{})},signal:controller.signal});clearTimeout(timeout);if(!r.ok)throw new Error(`Live product API ${r.status}`);const data=await r.json();const list=Array.isArray(data)?data:(data.products||data.items||[]);return list.slice(0,100).map(x=>({name:String(x.name||x.title||'Product'),sku:x.sku||x.code||null,price:Number(x.price||0),stock:Number(x.stock??x.quantity??0)}));}catch(err){logger.warn({err},'live product API failed; using local catalog');return dbProducts;}}

async function createOrderFromAgent(workspaceId,args,products){if(!args?.customerName||!args?.customerPhone||!args?.address||!Array.isArray(args.items)||!args.items.length)return{ok:false,error:'Missing required order details'};const resolved=[];for(const item of args.items){const p=products.find(x=>(item.sku&&x.sku===item.sku)||String(x.name).toLowerCase()===String(item.productName||'').toLowerCase());if(!p)return{ok:false,error:`Product not found: ${item.productName}`};const qty=Math.max(1,Number(item.quantity||1));if(Number(p.stock)<qty)return{ok:false,error:`Insufficient stock for ${p.name}`};resolved.push({productName:p.name,sku:p.sku,quantity:qty,unitPrice:Number(p.price),lineTotal:Number(p.price)*qty});}const total=resolved.reduce((s,x)=>s+x.lineTotal,0);const integration=await Integration.findOne({workspaceId,type:'custom_api',active:true}).lean();let externalOrderId=null;if(integration?.baseUrl){try{const url=new URL('/orders',integration.baseUrl);const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),7000);const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(integration.apiKeyEncrypted?{Authorization:`Bearer ${integration.apiKeyEncrypted}`}:{})},body:JSON.stringify({...args,items:resolved,total}),signal:controller.signal});clearTimeout(timeout);if(r.ok){const remote=await r.json().catch(()=>({}));externalOrderId=remote.id||remote.orderId||null;}}catch(err){logger.warn({err},'remote order creation failed; storing locally');}}const order=await Order.create({workspaceId,customerName:args.customerName,customerPhone:args.customerPhone,address:args.address,notes:args.notes||'',items:resolved,subtotal:total,total,status:'PENDING',source:externalOrderId?'whatsapp-api':'whatsapp',externalOrderId});return{ok:true,orderId:String(order._id),externalOrderId,total};}

app.use((err,req,res,_next)=>{logger.error({err,path:req.path},'request failed');if(err?.code===11000)return res.status(409).json({error:'A record with that value already exists'});if(err?.name==='ValidationError')return res.status(400).json({error:err.message});res.status(500).json({error:process.env.NODE_ENV==='production'?'Internal server error':err.message});});

async function main(){
  const uri=process.env.MONGODB_URI;if(!uri)throw new Error('MONGODB_URI is required. Use MongoDB Atlas or a local MongoDB server.');
  await mongoose.connect(uri,{serverSelectionTimeoutMS:10000});logger.info('MongoDB connected');
  // Remove the obsolete unique index from older schema versions. The current
  // Message model uses externalId; the old clientId:null index rejects every
  // second message in a conversation.
  await Message.collection.dropIndex('conversationId_1_clientId_1').catch(err=>{if(err.codeName!=='IndexNotFound')logger.warn({err},'old message index cleanup skipped');});
  await fs.mkdir(sessionRoot,{recursive:true});
  server.listen(port,async()=>{console.log(`WhatsApp Agent API running on http://localhost:${port}`);const existing=await WhatsappSession.find({mode:'QR',status:{$in:['connected','disconnected','qr']}}).sort({createdAt:-1}).catch(()=>[]);const restored=new Set();for(const s of existing){const workspace=String(s.workspaceId);if(restored.has(workspace)){await WhatsappSession.updateOne({_id:s._id},{$set:{status:'disconnected'}}).catch(()=>{});continue;}restored.add(workspace);startQrSession(s).catch(err=>logger.warn({err,sessionId:String(s._id)},'session restore failed'));}});
}
process.on('SIGTERM',async()=>{for(const st of sessions.values())try{st.sock?.end?.();}catch{}await mongoose.disconnect();server.close(()=>process.exit(0));});
process.on('SIGINT',async()=>{await mongoose.disconnect();server.close(()=>process.exit(0));});
main().catch(err=>{logger.fatal({err},'startup failed');process.exit(1);});
