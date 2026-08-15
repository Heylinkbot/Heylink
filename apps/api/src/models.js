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
  businessInfo: { type: Schema.Types.Mixed, default: () => ({ hours:'', contact:'', rules:['Always use API for price and stock.','Respond in the language used by the customer (English or Sinhala).','Transfer to human if customer asks or if AI is unsure.','Keep responses casual and brief.'] }) },
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
  active: { type: Boolean, default: true }
}, baseOptions);

const UserSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
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

const OrderSchema = new Schema({
  workspaceId:{type:Schema.Types.ObjectId,ref:'Workspace',required:true,index:true}, customerName:{type:String,required:true}, customerPhone:{type:String,required:true}, address:String, notes:String,
  items:{type:[Schema.Types.Mixed],default:[]}, subtotal:{type:Number,default:0}, total:{type:Number,default:0}, status:{type:String,enum:['PENDING','CONFIRMED','PREPARING','SHIPPED','DELIVERED','CANCELLED'],default:'PENDING'}, source:{type:String,default:'manual'}, externalOrderId:String
},baseOptions);

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

export const Workspace = model('Workspace',WorkspaceSchema);
export const User = model('User',UserSchema);
export const Product = model('Product',ProductSchema);
export const Faq = model('Faq',FaqSchema);
export const Order = model('Order',OrderSchema);
export const Conversation = model('Conversation',ConversationSchema);
export const Message = model('Message',MessageSchema);
export const Integration = model('Integration',IntegrationSchema);
export const DocumentTemplate = model('DocumentTemplate',DocumentTemplateSchema);
export const WhatsappSession = model('WhatsappSession',WhatsappSessionSchema);
export const PlatformConfig = model('PlatformConfig',PlatformConfigSchema);
