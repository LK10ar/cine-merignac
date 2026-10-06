const express=require("express"),mongoose=require("mongoose"),crypto=require("crypto"),path=require("path");
const {MONGODB_URI,TOKEN_SECRET="change-me",PORT=3000}=process.env;
// Si ADMIN_PASSWORD n'est pas défini sur l'hébergeur, le mot de passe par défaut est "admin1234"
const ADMIN_PASSWORD=(process.env.ADMIN_PASSWORD||"admin1234").trim();
console.log(process.env.ADMIN_PASSWORD?"ADMIN_PASSWORD défini ("+ADMIN_PASSWORD.length+" caractères)":"⚠ ADMIN_PASSWORD absent : mot de passe par défaut admin1234");
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
 if(!same(String(req.body.password||"").trim(),ADMIN_PASSWORD))return res.status(401).json({error:"Mot de passe incorrect"});
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
async function ensure(){
 const D={siteName:"Ciné Mérignac",primary:"#e5173f",bg:"#222222",panel:"#0a4f6b",prices:"Plein:11.70,Réduit:9.00,-18 ans ou Étudiant:8.00,-16 ans:6.60",seoTitle:"Ciné Mérignac – Films à l'affiche, horaires et réservation",seoDesc:"Site officiel du Ciné Mérignac : films à l'affiche, horaires des séances, informations sur les films, bandes-annonces et films à venir.",footer:"©2026 Ciné Mérignac",email:"merignac.cine@gmail.com",facebook:"https://www.facebook.com/Merignac-cine-10150103444810381",twitter:"https://twitter.com/MerignacCine",address:"",phone:"",footerLinks:""};
 const c=await Set.findOne();
 if(!c)await Set.create(D);else{const u={};for(const k in D)if(c.get(k)==null)u[k]=D[k];if(Object.keys(u).length)await Set.updateOne({_id:c._id},{$set:u})}
 if(!(await M.pages.countDocuments())){
  const L=[["Infos pratiques",1,1],["Contact",1,1],["Plan d'accès",1,1],["Tarifs",1,1],["Anniversaire",0,1],["CE et groupes",0,1],["Location de salle",0,1],["Comités d'entreprises",0,1],["Arbre de Noël",0,1],["Groupes",0,1],["Jeune-public",0,1],["Carte cinéma",0,1],["Politique de protection des données personnelles",0,1],["Mentions légales",0,1],["Charte cookies",0,1],["Conditions générales d'utilisation (CGU)",0,1],["Conditions générales du service de réservation en ligne (CGV)",0,1]];
  await M.pages.create(L.map(([title,inMenu,inFooter],i)=>({title,inMenu:!!inMenu,inFooter:!!inFooter,order:i+1,text:"Contenu à compléter depuis l'administration (menu Pages)."})));
 }
}

const IMG="https://www.cinemerignac.fr/evenement/660x0/649_";
const AC="https://fr.web.img%s.acsta.net/c_140_185_50_50/img/";
const FILMS=[["Cour(t)s au ciné ! #2","2h00","Courts-métrage","https://static.cotecine.fr/tb/Affiches/140x185/crop/611_637778.JPG","new"],["Digger","2h09","Tous publics",AC.replace("%s","3")+"ca/46/ca467fa6a145bb9d8fda93417d4374cf.jpg","new"],["Verity","1h54","Tout public avec avertissement",AC.replace("%s","6")+"f0/bf/f0bfbb3dc69cb51a8dadfbef66d50c07.jpg","new"],["Planètes","1h15","Tous publics",AC.replace("%s","3")+"ea/8f/ea8fb95276ef64374d453772434084b5.jpg","new"],["La Maison de nos rêves","1h30","Avant-première","","new"],["Avengers : Endgame Extended","3h05","Tous publics",AC.replace("%s","4")+"53/e1/53e1e6f2d34748e3f07d101e103dbfb6.jpg","old"],["Heart Of The Beast","1h41","Tous publics",AC.replace("%s","2")+"6f/af/6faf7d9aa879bd9374e773f31db44956.jpg","old"],["Justin le Juste","1h50","Tous publics",AC.replace("%s","6")+"a4/da/a4dac200a65518d1db35e7dba6ddd4e7.jpg","old"],["L'Abandon","1h40","Tout public avec avertissement",AC.replace("%s","5")+"2a/ff/2aff99358841773f126dd22734bbb72b.jpg","old"],["L'Invitation","1h47","Tous publics",AC.replace("%s","2")+"31/b1/31b1faa3ca361d78ca82078f8accda1e.jpg","old"],["Les Contrebandiers","1h53","Tout public avec avertissement",AC.replace("%s","3")+"14/20/142026a9ee3fb83800e19232c9cc0998.jpg","old"],["Les Ensorceleuses 2","2h10","Tous publics",AC.replace("%s","5")+"05/d0/05d0dcb033bc9dced645815301b59394.jpg","old"],["Pressure","1h40","Tous publics",AC.replace("%s","2")+"92/fb/92fb57911489ab17bfa8ecf0b29712c5.jpg","old"],["Tad l'explorateur et la lampe magique","1h35","Tous publics",AC.replace("%s","2")+"7a/89/7a89c362c3c4180669ce471a947d2f70.jpg","old"],["Tombé du ciel","1h32","Tous publics",AC.replace("%s","5")+"78/a7/78a70db88122966584f6dd674da06a6d.jpg","old"],["Spider-Man: Brand New Day","2h25","Tous publics",AC.replace("%s","5")+"cd/90/cd90255ae37ff659dab73bd1c422c9b5.jpg","old"]];
const EVENTS=[["AVANT-PREMIÈRE « Un bon patron »","Avant-première","Vendredi 23 octobre à 19h00","Venez rencontrer Didier Bourdon et le réalisateur Philippe de Chauveron à l'avant-première de leur comédie Un bon patron. Réservez vos places dès maintenant !","1790754907.png"],["AVENGERS DOOMSDAY – ouverture des préventes","Préventes","Dès aujourd'hui","Réservez dès aujourd'hui vos places pour la sortie du film évènement « Avengers : Doomsday ».","1791207477.jpg"],["SÉANCE SPÉCIALE « Cars »","Séance spéciale","Sam. 10 oct. à 16h15 et dim. 11 oct. à 10h15","Pour les 20 ans du film, Cars sort exceptionnellement au cinéma !","1791202653.jpg"],["AVANT-PREMIÈRE « Mochy, le chien le plus moche du monde »","Avant-première","Dimanche 11 octobre à 16h45","Assistez en famille à l'avant-première de Mochy ! La SPA de Mérignac sera présente pour parler de ses activités.","1791120008.jpg"],["CINÉ-DÉBAT « Le bonheur c'est la paix »","Ciné-débat","13 octobre à 19h00","La Maison Ukrainienne vous invite à découvrir le documentaire Le bonheur c'est la paix. Entrée gratuite, inscription sur HelloAsso. L'artiste Jofo sera présent pour échanger.","1791284245.jpg"],["CINÉ-DÉBAT « Garance »","Ciné-débat","Jeudi 15 octobre à 18h45","Le nouveau film de Jeanne Herry, Garance. Le film sera suivi d'un échange avec l'association des Alcooliques Anonymes.","1791306862.jpg"],["MINOKINO « Le monde à l'envers »","Minokino","Jeudi 22 octobre à 10h30","1 goûter + 1 spectacle + 1 film. Spectacle « L'heure du chat » par la Cie Soria. Tarif unique : 7 €.","1790163221.jpg"],["MINOKINO « Le cygne et l'enfant »","Minokino","Vendredi 30 octobre à 10h30","1 goûter + 1 spectacle + 1 film. « Conte à plumes » par Stéphanie Lafitte. Tarif unique : 7 €.","1790163334.jpg"],["CINÉ-DÉBAT « Premières lunes »","Ciné-débat","Mardi 3 novembre à 19h00","En partenariat avec La Parenthèse : documentaire sur les premières règles, suivi d'un échange avec Sarah Cruchet.","1791292353.jpg"],["CINÉ-DÉBAT « Moulin »","Ciné-débat","Vendredi 6 novembre à 18h45","Rencontre avec Romain Cadet, doctorant en histoire contemporaine à l'Université Bordeaux Montaigne, à l'issue de la séance.","1791207129.jpg"],["SÉANCES JEUNES PARENTS","Jeunes parents","Chaque semaine","Séances accessibles aux jeunes parents avec des bébés de moins de 2 ans, son adapté. Tarif unique : 6 €, gratuit pour les moins de 2 ans. Table à langer au rez-de-chaussée.",""],["AUDIODESCRIPTION & AMPLIFICATION SONORE","Accessibilité","Toutes nos salles","Toutes les salles sont équipées pour l'audiodescription et l'amplification sonore malentendants (prêt de l'appareil en caisse, pièce d'identité en garantie). Merci de vous munir de votre casque personnel.",""]];
const NEWS=[["Nos popcorns n'aiment pas les déchets","Le Mérignac-Ciné vous offre la possibilité d'acheter votre popcorn préféré sans jeter l'emballage : apportez votre contenant et payez uniquement la recharge. Volumes : mini 0,71 L, moyen 1,36 L, maxi 2,5 L."],["Café Culture Mérignacais","Envie de ne rien rater de l'actualité culturelle de Mérignac ? Rejoignez le WhatsApp du Café Culture Mérignacais : Café Actu, Café Lecture et Ciné Rencontre, trois rendez-vous mensuels."],["Programme fidélité","La Carte Cinéma du Mérignac-Ciné évolue : elle permet désormais de gagner des places de cinéma, de la confiserie et des cadeaux."]];
async function ensure2(){
 const c=await Set.findOne();
 await Set.updateOne({_id:c._id,address:{$in:["",null]}},{$set:{address:"6 place Charles de Gaulle, 33700 Mérignac"}});
 for(const[k,v]of Object.entries({headerBg:"#1b1b1b",headerText:"#ffffff",footerBg:"#e5173f",footerText:"#ffffff",fontFamily:"Montserrat"}))if(c.get(k)==null)await Set.updateOne({_id:c._id},{$set:{[k]:v}});
 if(!c.get("imported")){
  const SAMPLE=["Ducobu et le fantôme de Saint-Potache","Pressure","Mochy, le chien le plus moche du monde","La Maison de nos rêves","The Social Reckoning"];
  const fl=await M.films.find();
  if(fl.every(f=>SAMPLE.includes(f.title))){
   for(const m of[M.films,M.seances,M.events,M.news])await m.deleteMany({});
   await M.films.create(FILMS.map(([title,duration,rating,poster,status])=>({title,duration,rating,poster,status,featured:false})));
   await M.events.create(EVENTS.map(([title,label,date,text,im])=>({title,label,date,text,image:im?IMG+im:""})));
   await M.news.create(NEWS.map(([title,text])=>({title,text})));
  }
  await Set.updateOne({_id:c._id},{$set:{imported:true}});
 }
 if(!(await M.pages.countDocuments({isHome:true})))await M.pages.create({title:"Accueil",isHome:true,order:0,blocks:[{type:"carousel"},{type:"today"},{type:"soon"},{type:"events"},{type:"news"}]});
 const mn=c.get("menu");
 if(!Array.isArray(mn)||!mn.length){const pg=await M.pages.find({inMenu:true}).sort({order:1});await Set.updateOne({_id:c._id},{$set:{menu:[{label:"Films",url:"#/films"},{label:"Évènements",url:"#/events"},{label:"Actualités",url:"#/actus"},...pg.map(p=>({label:p.title,url:"#/page/"+p._id}))]}})}
}
mongoose.connect(MONGODB_URI).then(async()=>{if(!(await M.films.countDocuments()))await seed();await ensure();await ensure2();app.listen(PORT,()=>console.log("Ciné sur le port "+PORT))}).catch(e=>{console.error("MongoDB :",e.message);process.exit(1)});
