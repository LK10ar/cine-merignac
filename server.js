const express=require("express"),mongoose=require("mongoose"),crypto=require("crypto"),path=require("path");
const {MONGODB_URI,TOKEN_SECRET="change-me",PORT=3000}=process.env;
// Si ADMIN_PASSWORD n'est pas défini sur l'hébergeur, le mot de passe par défaut est "admin1234"
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"admin1234";
if(!process.env.ADMIN_PASSWORD)console.warn("⚠ ADMIN_PASSWORD absent : mot de passe par défaut 'admin1234'. Définissez-le !");
const app=express();app.set("trust proxy",1);app.use(express.json({limit:"12mb"}));
app.use(express.static(path.join(__dirname,"public")));app.get("/healthz",(_,r)=>r.send("ok"));
const S=(o)=>new mongoose.Schema(o,{timestamps:true,strict:false});
const M={
films:mongoose.model("Film",S({title:{type:String,required:true}})),
seances:mongoose.model("Seance",S({film:{type:mongoose.Schema.Types.ObjectId,ref:"Film",required:true},date:{type:String,required:true},time:{type:String,required:true}})),
events:mongoose.model("Event",S({title:{type:String,required:true}})),
news:mongoose.model("News",S({title:{type:String,required:true}})),
pages:mongoose.model("Page",S({title:{type:String,required:true}})),
};
const Set=mongoose.model("Setting",S({}));
const sign=d=>crypto.createHmac("sha256",TOKEN_SECRET).update(d).digest("base64url");
const same=(a,b)=>{a=Buffer.from(String(a));b=Buffer.from(String(b));return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const tries=new Map();
app.post("/api/login",(req,res)=>{
 const t=tries.get(req.ip)||{n:0,r:Date.now()+9e5};if(Date.now()>t.r){t.n=0;t.r=Date.now()+9e5}
 if(t.n>=10)return res.status(429).json({error:"Trop d'essais, réessayez dans 15 min"});
 t.n++;tries.set(req.ip,t);
 if(!same(req.body.password||"",ADMIN_PASSWORD))return res.status(401).json({error:"Mot de passe incorrect"});
 t.n=0;const p=Buffer.from(JSON.stringify({exp:Date.now()+12*36e5})).toString("base64url");
 res.json({token:p+"."+sign(p)});
});
const auth=(req,res,next)=>{const[p,s]=(req.headers.authorization||"").replace("Bearer ","").split(".");
 try{if(p&&s&&same(s,sign(p))&&JSON.parse(Buffer.from(p,"base64url")).exp>Date.now())return next()}catch{}
 res.status(401).json({error:"Non autorisé"})};
for(const[name,Model]of Object.entries(M)){
 const r=express.Router();
 r.get("/",async(q,s)=>s.json(await Model.find(q.query.film?{film:q.query.film}:{}).sort(name=="seances"?{date:1,time:1}:{createdAt:-1})));
 r.post("/",auth,async(q,s)=>{try{s.status(201).json(await Model.create(q.body))}catch(e){s.status(400).json({error:e.message})}});
 r.put("/:id",auth,async(q,s)=>{try{s.json(await Model.findByIdAndUpdate(q.params.id,q.body,{new:true,runValidators:true,overwrite:false}))}catch(e){s.status(400).json({error:e.message})}});
 r.delete("/:id",auth,async(q,s)=>{await Model.findByIdAndDelete(q.params.id);if(name=="films")await M.seances.deleteMany({film:q.params.id});s.json({ok:true})});
 app.use("/api/"+name,r);
}
// Réglages du site (un seul document) : lecture publique, écriture admin
app.get("/api/settings",async(_,s)=>s.json((await Set.findOne())||{}));
app.put("/api/settings",auth,async(q,s)=>{const d=await Set.findOne();s.json(d?await Set.findByIdAndUpdate(d._id,q.body,{new:true}):await Set.create(q.body))});
async function seed(){
 const f=await M.films.create([
 {title:"La Maison de nos rêves",duration:"1h30",genre:"Comédie",status:"new",featured:true,synopsis:"Un jeune couple pense avoir trouvé la solution miracle pour devenir propriétaire : un viager…"},
 {title:"Ducobu et le fantôme de Saint-Potache",duration:"1h30",genre:"Comédie, Famille",director:"Elie Semoun",status:"old",featured:true},
 {title:"The Social Reckoning",duration:"1h52",genre:"Drame",director:"Aaron Sorkin",status:"old"}]);
 const d=new Date(),k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
 await M.seances.create(["14h00","16h30","19h00"].map(time=>({film:f[0]._id,date:k,time,room:"Salle 1",version:"VF"})));
 await M.events.create({title:"Un bon patron",label:"Avant-première",date:"23 oct.",text:"Soirée en présence de l'équipe, à 19h."});
 await M.news.create({title:"Bienvenue sur notre nouveau site",text:"Retrouvez toute la programmation et réservez en ligne."});
 await Set.create({siteName:"Ciné Mérignac",primary:"#e5173f",bg:"#222222",panel:"#0a4f6b",prices:"Plein:11.70,Réduit:9.00,-18 ans ou Étudiant:8.00,-16 ans:6.60",seoDesc:"Horaires, films à l'affiche et réservation en ligne."});
}
mongoose.connect(MONGODB_URI).then(async()=>{if(!(await M.films.countDocuments()))await seed();app.listen(PORT,()=>console.log("Ciné sur le port "+PORT))}).catch(e=>{console.error("MongoDB :",e.message);process.exit(1)});
