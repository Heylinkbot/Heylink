import mongoose from 'mongoose';

const { Schema, model } = mongoose;

const baseOptions = {
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform(_doc, ret) {
      ret.id = String(ret._id);
      delete ret._id;
      delete ret.__v;
      return ret;
    }
  }
};

const WorkspaceSchema = new Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  currency: { type: String, default: 'LKR' },
  defaultLanguage: { type: String, default: 'auto' },
  systemPrompt: { type: String, default: 'You are a casual, sales-focused WhatsApp assistant. Your primary goal is to turn inquiries into orders. You must: 1. Use the provided API to check live product price and stock. 2. Recommend products based on customer needs. 3. Collect order details: product, quantity, name, phone, address, and notes. 4. Create orders via API. 5. Answer questions on delivery, warranty, and returns based on business data. 6. Understand and reply naturally in both Sinhala and English (match the customer language). 7. Never invent data; if unknown, transfer to a human. 8. Keep responses short and friendly.' },
  capabilities: { type: [String], default: ['api_integration','order_collection','multilingual_support','human_handoff'] },
  businessInfo: { type: Schema.Types.Mixed, default: () => ({ description:'', address:'', hours:'', contact:'', deliveryPolicy:'', paymentPolicy:'', warrantyPolicy:'', returnPolicy:'', salesInstructions:'', replyStyle:'', maxRecommendations:3, orderConfirmation:'', rules:['Always use API for price and stock.','Respond in the language used by the customer (English, Sinhala, or Singlish).','Recommend only relevant in-stock products with exact current price.','Ask one useful question when requirements are unclear.','Transfer to human if customer asks or if AI is unsure.','Keep responses casual, concise, and sales-focused.'] }) },
  welcomeSequence: { type: [Schema.Types.Mixed], default: () => [{type:'text',content:"Hi! How can I help you find what you're looking for today? / ආයුබෝවන්! අද මම ඔබට උදව් කරන්නේ කෙසේද?"}] },
  paymentMethods: { type: [Schema.Types.Mixed], default: [] },
  collectionFields: { type: [Schema.Types.Mixed], default: [] },
  followupSettings: { type: Schema.Types.Mixed, default: () => ({}) },
  notificationSettings: { type: Schema.Types.Mixed, default: () => ({}) },
  plan: { type: String, default: 'FREE' },
  conversationLimit: { type: Number, default: 20 },
  aiActionLimit: { type: Number, default: 50 },
  conversationUsage: { type: Number, default: 0 },
  aiActionUsage: { type: Number, default: 0 },
  aiUsagePeriod: { type: String, default: '' },
  active: { type: Boolean, default: true }
}, baseOptions);

const UserSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  googleId: { type: String, unique: true, sparse: true },
  passwordResetTokenHash: { type: String, select: false },
  passwordResetExpiresAt: { type: Date, select: false },
  displayName: String,
  role: { type: String, enum:['SUPERADMIN','OWNER','STAFF'], default:'OWNER' },
  workspaceId: { type: Schema.Types.ObjectId, ref:'Workspace', default:null },
  active: { type:Boolean, default:true }
}, baseOptions);

const ProductSchema = new Schema({
  workspaceId: { type:Schema.Types.ObjectId, ref:'Workspace', required:true, index:true },
  name: { type:String, required:true }, sku:String, description:String, category:String,
  price:{type:Number,default:0,min:0}, stock:{type:Number,default:0,min:0}, active:{type:Boolean,default:true}, externalId:String
}, baseOptions);
ProductSchema.index({workspaceId:1,sku:1},{sparse:true});

const FaqSchema = new Schema({workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true},question:{type:String,required:true},answer:{type:String,required:true},productId:{type:Schema.Types.ObjectId,ref:'Product',default:null},active:{type:Boolean,default:true}},baseOptions);

const KnowledgeEntrySchema = new Schema({
  workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true},
  question:{type:String,required:true,trim:true,maxlength:1000},
  answer:{type:String,required:true,trim:true,maxlength:4000},
  status:{type:String,enum:['PENDING','APPROVED'],default:'PENDING',index:true},
  source:{type:String,enum:['MANUAL','HUMAN_REPLY'],default:'MANUAL'},
  active:{type:Boolean,default:true},
  approvedAt:{type:Date,default:null}
},baseOptions);
KnowledgeEntrySchema.index({workspaceId:1,status:1,updatedAt:-1});

const OrderSchema = new Schema({
  workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true}, customerName:{type:String,required:true}, customerPhone:{type:String,required:true}, address:String, notes:String,
  items:{type:[Schema.Types.Mixed],default:[]},discounts:{type:[Schema.Types.Mixed],default:[]},subtotal:{type:Number,default:0},discountTotal:{type:Number,default:0},total:{type:Number,default:0},status:{type:String,enum:['PENDING','CONFIRMED','PREPARING','SHIPPED','DELIVERED','CANCELLED'],default:'PENDING'},source:{type:String,default:'manual'},externalOrderId:String
},baseOptions);
OrderSchema.pre('validate',async function(){if(this.source==='shopzen-whatsapp-hub'||this.isModified('status')&&!this.isNew)return;const Rule=this.model('BusinessRule');const now=new Date();const rules=await Rule.find({workspaceId:this.workspaceId,type:'QUANTITY_DISCOUNT',active:true,$and:[{$or:[{startAt:null},{startAt:{$lte:now}}]},{$or:[{endAt:null},{endAt:{$gte:now}}]}]}).sort({priority:1}).lean();const eligible=rules.filter(rule=>{const quantity=(this.items||[]).filter(x=>!rule.conditions?.sku||String(x.sku)===String(rule.conditions.sku)).reduce((n,x)=>n+Number(x.quantity||0),0);return quantity>=Number(rule.conditions?.minQuantity||1);}).sort((a,b)=>Number(b.actions?.percent||0)-Number(a.actions?.percent||0));const best=eligible[0];if(!best){this.discounts=[];this.discountTotal=0;return;}const percent=Math.min(100,Math.max(0,Number(best.actions?.percent||0)));const amount=Number((Number(this.subtotal||0)*percent/100).toFixed(2));this.discounts=[{ruleId:String(best._id),name:best.name,type:best.type,percent,amount}];this.discountTotal=amount;this.total=Math.max(0,Number(this.subtotal||0)-amount);});

const ConversationSchema = new Schema({
  workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true}, phone:{type:String,required:true}, whatsappJid:String, customerName:String, status:{type:String,enum:['OPEN','HUMAN','CLOSED'],default:'OPEN'}, humanHandoff:{type:Boolean,default:false}, unreadCount:{type:Number,default:0}, sentiment:{type:String,enum:['positive','neutral','negative'],default:'neutral'}
},baseOptions);
ConversationSchema.index({workspaceId:1,phone:1},{unique:true});

const MessageSchema = new Schema({conversationId:{type:Schema.Types.ObjectId,ref:'Conversation',required:true,index:true},direction:{type:String,enum:['in','out'],required:true},body:{type:String,required:true},externalId:String,status:{type:String,default:'sent'}},baseOptions);
MessageSchema.index({externalId:1},{unique:true,sparse:true});

const IntegrationSchema = new Schema({workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true},type:{type:String,required:true},name:{type:String,required:true},baseUrl:String,apiKeyEncrypted:String,config:{type:Schema.Types.Mixed,default:()=>({})},active:{type:Boolean,default:true}},baseOptions);

const DocumentTemplateSchema = new Schema({workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true},name:{type:String,required:true},type:{type:String,default:'invoice'},template:{type:Schema.Types.Mixed,default:()=>({})}},baseOptions);

const WhatsappSessionSchema = new Schema({
  workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true}, name:{type:String,required:true}, mode:{type:String,enum:['QR','META'],default:'QR'}, status:{type:String,default:'pending'}, phone:String,
  metaPhoneNumberId:String, metaBusinessAccountId:String, metaAccessToken:String, metaVerifyToken:String
},baseOptions);

const PlatformConfigSchema = new Schema({
  key:{type:String,unique:true,required:true},
  ai:{type:Schema.Types.Mixed,default:()=>({provider:'openai',model:'gpt-5-mini',baseURL:'',apiKey:'',apiKeyConfigured:false})},
  plans:{type:[Schema.Types.Mixed],default:()=>[
    {key:'FREE',name:'Free',monthlyPrice:0,currency:'LKR',conversationLimit:20,aiActionLimit:50,active:true},
    {key:'STARTER',name:'Starter',monthlyPrice:2500,currency:'LKR',conversationLimit:500,aiActionLimit:1000,active:true},
    {key:'PRO',name:'Pro',monthlyPrice:7500,currency:'LKR',conversationLimit:2500,aiActionLimit:5000,active:true}
  ]},
  settings:{type:Schema.Types.Mixed,default:()=>({maintenanceMode:false,allowQr:true,defaultCurrency:'LKR',supportEmail:''})}
},baseOptions);

const CustomerSchema = new Schema({
  workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true},
  phone:{type:String,required:true,trim:true},name:String,email:String,
  language:{type:String,enum:['auto','en','si','ta','singlish'],default:'auto'},
  interests:{type:[String],default:[]},preferences:{type:Schema.Types.Mixed,default:()=>({})},
  previousOrderIds:{type:[Schema.Types.ObjectId],default:[]},lifetimeValue:{type:Number,default:0},
  complaints:{type:[String],default:[]},lastSeenAt:{type:Date,default:Date.now}
},baseOptions);
CustomerSchema.index({workspaceId:1,phone:1},{unique:true});

const ConversationStateSchema = new Schema({
  workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true},
  conversationId:{type:Schema.Types.ObjectId,ref:'Conversation',required:true,unique:true},
  stage:{type:String,enum:['DISCOVERY','PRODUCT_SELECTED','QUANTITY_COLLECTED','CUSTOMER_DETAILS','ORDER_REVIEW','CUSTOMER_CONFIRMED','TOOL_EXECUTION','CONFIRMED','FAILED'],default:'DISCOVERY'},
  intent:{type:String,default:'unknown'},selectedProducts:{type:[Schema.Types.Mixed],default:[]},
  constraints:{type:Schema.Types.Mixed,default:()=>({})},collectedFields:{type:Schema.Types.Mixed,default:()=>({})},
  missingFields:{type:[String],default:[]},pendingOrder:{type:Schema.Types.Mixed,default:null},summary:{type:String,default:''}
},baseOptions);

const KnowledgeChunkSchema = new Schema({
  workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true},
  sourceType:{type:String,enum:['MANUAL','FAQ','PRODUCT','WEBSITE','DOCUMENT','CONVERSATION','CONNECTOR'],required:true},
  sourceId:{type:String,required:true},title:{type:String,default:''},content:{type:String,required:true,maxlength:12000},
  chunkIndex:{type:Number,default:0},embedding:{type:[Number],select:false,default:undefined},
  confidence:{type:Number,min:0,max:1,default:1},permissions:{type:[String],default:['OWNER','STAFF','AGENT']},
  checksum:{type:String,index:true},sourceUpdatedAt:Date,embeddedAt:Date,active:{type:Boolean,default:true},metadata:{type:Schema.Types.Mixed,default:()=>({})}
},baseOptions);
KnowledgeChunkSchema.index({workspaceId:1,sourceType:1,sourceId:1,chunkIndex:1},{unique:true});
KnowledgeChunkSchema.index({workspaceId:1,active:1,updatedAt:-1});

const KnowledgeSourceSchema = new Schema({
  workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true},
  type:{type:String,enum:['MANUAL_TEXT','WEBSITE','DOCUMENT','CONNECTOR'],required:true},
  name:{type:String,required:true,trim:true},uri:{type:String,default:''},
  status:{type:String,enum:['PENDING','PROCESSING','READY','FAILED','DISABLED'],default:'PENDING',index:true},
  checksum:String,lastSyncedAt:Date,nextSyncAt:Date,error:String,
  chunkCount:{type:Number,default:0},metadata:{type:Schema.Types.Mixed,default:()=>({})},active:{type:Boolean,default:true}
},baseOptions);
KnowledgeSourceSchema.index({workspaceId:1,type:1,uri:1});

const AiExecutionSchema = new Schema({
  workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true},conversationId:{type:Schema.Types.ObjectId,ref:'Conversation',index:true},messageId:{type:Schema.Types.ObjectId,ref:'Message'},
  intent:String,retrievedKnowledgeIds:{type:[Schema.Types.ObjectId],default:[]},toolExecutions:{type:[Schema.Types.Mixed],default:[]},
  sources:{type:[Schema.Types.Mixed],default:[]},confidence:{type:Number,min:0,max:1,default:0},validationResult:{type:String,default:'UNVALIDATED'},
  provider:String,model:String,promptTokens:Number,completionTokens:Number,latencyMs:Number,fallbackUsed:{type:Boolean,default:false},error:String
},baseOptions);

const AiFeedbackSchema = new Schema({
  workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true},conversationId:{type:Schema.Types.ObjectId,ref:'Conversation'},messageId:{type:Schema.Types.ObjectId,ref:'Message'},
  customerQuestion:String,aiAnswer:String,sourceIds:{type:[String],default:[]},confidence:Number,rating:{type:Number,min:-1,max:1},
  humanCorrection:String,status:{type:String,enum:['PENDING','APPROVED','REJECTED'],default:'PENDING'},reviewedBy:{type:Schema.Types.ObjectId,ref:'User'},reviewedAt:Date
},baseOptions);

const SyncJobSchema = new Schema({
  workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true},integrationId:{type:Schema.Types.ObjectId,ref:'Integration',index:true},
  type:{type:String,required:true},status:{type:String,enum:['PENDING','RUNNING','SUCCEEDED','FAILED','DEAD'],default:'PENDING',index:true},
  cursor:String,attempts:{type:Number,default:0},maxAttempts:{type:Number,default:5},nextRunAt:{type:Date,default:Date.now,index:true},
  startedAt:Date,completedAt:Date,error:String,stats:{type:Schema.Types.Mixed,default:()=>({})},idempotencyKey:{type:String,unique:true,sparse:true}
},baseOptions);

const AuditLogSchema = new Schema({
  workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',index:true},actorId:{type:Schema.Types.ObjectId,ref:'User'},actorRole:String,
  action:{type:String,required:true,index:true},resourceType:String,resourceId:String,ip:String,userAgent:String,metadata:{type:Schema.Types.Mixed,default:()=>({})}
},baseOptions);

const BusinessRuleSchema = new Schema({
  workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true},name:{type:String,required:true,trim:true},
  type:{type:String,enum:['QUANTITY_DISCOUNT','VIP_PRIORITY','ORDER_MINIMUM','FREE_DELIVERY'],required:true,index:true},
  conditions:{type:Schema.Types.Mixed,default:()=>({})},actions:{type:Schema.Types.Mixed,default:()=>({})},
  priority:{type:Number,default:100},startAt:Date,endAt:Date,active:{type:Boolean,default:true},description:{type:String,default:''}
},baseOptions);
BusinessRuleSchema.index({workspaceId:1,active:1,priority:1});

export const Workspace = model('Workspace',WorkspaceSchema);
export const User = model('User',UserSchema);
export const Product = model('Product',ProductSchema);
export const Faq = model('Faq',FaqSchema);
export const KnowledgeEntry = model('KnowledgeEntry',KnowledgeEntrySchema);
export const Order = model('Order',OrderSchema);
export const Conversation = model('Conversation',ConversationSchema);
export const Message = model('Message',MessageSchema);
export const Integration = model('Integration',IntegrationSchema);
export const DocumentTemplate = model('DocumentTemplate',DocumentTemplateSchema);
export const WhatsappSession = model('WhatsappSession',WhatsappSessionSchema);
export const PlatformConfig = model('PlatformConfig',PlatformConfigSchema);
export const Customer = model('Customer',CustomerSchema);
export const ConversationState = model('ConversationState',ConversationStateSchema);
export const KnowledgeChunk = model('KnowledgeChunk',KnowledgeChunkSchema);
export const KnowledgeSource = model('KnowledgeSource',KnowledgeSourceSchema);
export const AiExecution = model('AiExecution',AiExecutionSchema);
export const AiFeedback = model('AiFeedback',AiFeedbackSchema);
export const SyncJob = model('SyncJob',SyncJobSchema);
export const AuditLog = model('AuditLog',AuditLogSchema);
export const BusinessRule = model('BusinessRule',BusinessRuleSchema);
