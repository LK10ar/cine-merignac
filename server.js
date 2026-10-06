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
// Séances sur une période : film + date de début/fin + jours + horaires
const pad2=n=>String(n).padStart(2,"0"),isoU=d=>d.getUTCFullYear()+"-"+pad2(d.getUTCMonth()+1)+"-"+pad2(d.getUTCDate());
app.post("/api/seances/bulk",auth,async(q,s)=>{try{
 const{film,date,dateTo,days,times,room,version,thx}=q.body||{},re=/^\d{4}-\d{2}-\d{2}$/;
 if(!film||!re.test(date||""))return s.status(400).json({error:"Film et date de début obligatoires"});
 const end=re.test(dateTo||"")?dateTo:date;if(end<date)return s.status(400).json({error:"La date de fin est avant la date de début"});
 const T=(Array.isArray(times)?times:[]).map(t=>String(t).trim()).filter(Boolean);if(!T.length)return s.status(400).json({error:"Indiquez au moins un horaire"});
 const W=Array.isArray(days)&&days.length?days.map(Number):[0,1,2,3,4,5,6],out=[];
 for(const d=new Date(date+"T00:00:00Z"),e=new Date(end+"T00:00:00Z");d<=e;d.setUTCDate(d.getUTCDate()+1)){
  if(!W.includes(d.getUTCDay()))continue;
  for(const time of T)out.push({film,date:isoU(d),time,room:room||"",version:version||"VF",thx:!!thx});
  if(out.length>3000)return s.status(400).json({error:"Trop de séances d'un coup (maximum 3000) : réduisez la période"});
 }
 const ex=await M.seances.find({film,date:{$gte:date,$lte:end}}).select("date time"),have=new Set(ex.map(x=>x.date+"|"+x.time)),nw=out.filter(x=>!have.has(x.date+"|"+x.time));
 if(nw.length)await M.seances.insertMany(nw);
 s.json({created:nw.length,skipped:out.length-nw.length});
}catch(e){s.status(400).json({error:e.message})}});
app.post("/api/seances/purge",auth,async(q,s)=>{try{
 const{film,before}=q.body||{},f={};if(film)f.film=film;if(before)f.date={$lt:before};
 if(!film&&!before)return s.status(400).json({error:"Précisez un film ou une date"});
 s.json({deleted:(await M.seances.deleteMany(f)).deletedCount});
}catch(e){s.status(400).json({error:e.message})}});
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
 if(!c.get("brand")){
  if(c.get("primary")==="#e5173f"&&!c.get("logo"))await Set.updateOne({_id:c._id},{$set:{primary:"#c32b34",bg:"#2b2b2b",panel:"#4e4848",headerBg:"#000000",footerBg:"#c32b34",fontFamily:"Open Sans",headingFont:"Audiowide",logo:"https://www.cinemerignac.fr/image/logo.png"}});
  await Set.updateOne({_id:c._id},{$set:{brand:true}});
 }
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

// ===== Infos reprises du site officiel Ciné Mérignac (importées une seule fois) =====
const REAL=[
{title:"Ducobu et le fantôme de Saint-Potache",duration:"1h30",rating:"Tous publics",genre:"Comédie, Famille",director:"Elie Semoun",cast:"Charlie Garnier Naslin, Elie Semoun, Émilie Caen, Frédérique Bel, Loïc Legendre",releaseDate:"7 octobre 2026",status:"new",featured:true,version:"VF",pmr:true,synopsis:"C'est Halloween, et Ducobu revient pour une aventure pleine de rires et de mystères ! Le professeur Latouche et Mademoiselle Rateau emménagent dans une maison... hantée par le fantôme d'Anatole, le plus grand cancre de l'histoire de l'école Saint-Potache. Ce fantôme farceur va entraîner Ducobu, Léonie, leurs parents et Kitrish dans une série de péripéties aussi drôles qu'inattendues. Mais attention : à Halloween, tout peut arriver..."},
{title:"La Maison de nos rêves",duration:"1h30",rating:"Tous publics",genre:"Comédie",director:"Claude Zidi Jr.",cast:"Kev Adams, Chantal Ladesou, Camille Aguilar, Jonathan Lambert, Michel Jonasz",releaseDate:"7 octobre 2026",status:"new"},
{title:"Mochy, le chien le plus moche du monde",duration:"1h25",rating:"Tous publics",genre:"Animation",director:"Jérémie Degruson, Yanis Belaid",releaseDate:"14 octobre 2026",status:"soon"},
{title:"Le Monde à l'envers",duration:"0h45",genre:"Animation, Famille",director:"Arnaud Demuynck, Noé Garcia, Erwann Hette, Pascale Hecquet, Stéphanie Yang Chun",releaseDate:"7 octobre 2026",status:"new"},
{title:"Retour au collège",duration:"1h25",rating:"Tous publics",genre:"Documentaire",director:"Antoine Fromental",releaseDate:"7 octobre 2026",status:"new"},
{title:"Cars",duration:"1h57",rating:"Tous publics",genre:"Animation, comédie, action, fantastique",director:"John Lasseter",cast:"Guillaume Canet, Bernard-Pierre Donnadieu, Cécile De France, Samuel Le Bihan, Guillaume Orsat",releaseDate:"30 septembre 2026",status:"old"},
{title:"Digger",duration:"2h09",rating:"Tous publics",genre:"Action, comédie",director:"Alejandro Gonzalez Iñárritu",cast:"Tom Cruise, Sandra Hüller, Riz Ahmed, John Goodman, Michael Stuhlbarg",releaseDate:"30 septembre 2026",status:"new"},
{title:"Verity",duration:"1h54",rating:"Tout public avec avertissement",genre:"Drame, Romance, thriller",director:"Michael Showalter",cast:"Anne Hathaway, Dakota Johnson, Josh Hartnett, Ismael Cruz Cordova, Brady Wagner",releaseDate:"30 septembre 2026",status:"new"},
{title:"Heart Of The Beast",duration:"1h41",rating:"Tous publics",genre:"Action, aventure",director:"David Ayer",cast:"Brad Pitt, Uber, J.K. Simmons, Anna Lambe",releaseDate:"23 septembre 2026",status:"old"},
{title:"Justin le Juste",duration:"1h50",rating:"Tous publics",genre:"Historique, guerre",director:"Eric Barbier",cast:"Alban Ivanov, Birane Ba, Alexandra Lamy, Thierry Hancisse, Nicolas Avinée",releaseDate:"23 septembre 2026",status:"old"},
{title:"L'Invitation",duration:"1h47",rating:"Tous publics",genre:"Comédie",director:"Olivia Wilde",cast:"Seth Rogen, Olivia Wilde, Pénélope Cruz, Edward Norton, Skip Howland",releaseDate:"16 septembre 2026",status:"old"},
{title:"Les Contrebandiers",duration:"1h53",rating:"Tout public avec avertissement",genre:"Thriller, action, aventure",director:"Padraic McKinley",cast:"Ethan Hawke, Russell Crowe, Julia Jones, Austin Amelio, Avi Nash",releaseDate:"16 septembre 2026",status:"old"},
{title:"Les Héros du Louvre",duration:"1h45",rating:"Tous publics",genre:"Drame, Historique",director:"Elie Chouraqui",cast:"Kad Merad, Marie Gillain, Julia de Nunez, Fantine Guyot, Jean-Hugues Anglade",releaseDate:"9 septembre 2026",status:"old"},
{title:"Pressure",duration:"1h40",rating:"Tous publics",genre:"Thriller, Historique, guerre",director:"Anthony Maras",cast:"Andrew Scott, Brendan Fraser, Kerry Condon, Chris Messina, Damian Lewis",releaseDate:"9 septembre 2026",status:"old"},
{title:"Tombé du ciel",duration:"1h32",rating:"Tous publics",genre:"Comédie, Famille",director:"Mohamed Hamidi",cast:"Ilyes Djadel, Josiane Balasko, Fred Testot, Antoine Dulery, Jamel Debbouze",releaseDate:"12 août 2026",status:"old"}
];
const TARIFS_TXT="TARIFS (hors frais de gestion)\n\nNormal : 9,00 €\nRéduit : 6,50 €\nCarte jeune : 6,50 €\nFamille nombreuse : 6,50 €\nSenior : 6,50 €\nÉtudiant : 6,50 €\nMoins de 18 ans : 6,50 €\nSéances Jeunes parents : 6,00 € (gratuit pour les moins de 2 ans)\nMinokino : tarif unique 7 €\n\nMoyens de paiement acceptés : carte bancaire, carte d'abonnement, place unitaire du Ciné Mérignac, contremarques Recif, Chèque Cinéma Universel, Ciné Chèque (e-billet uniquement, aucune annulation possible).\n\nFRAIS DE GESTION (réservation en ligne, une seule fois par commande)\nJusqu'à 13 € : 0,25 € • de 13 à 30 € : 0,50 € • de 30 à 50 € : 0,75 € • de 50 à 80 € : 1,00 € • plus de 80 € : 1,50 €";
const INFOS_TXT="RÉSERVATION EN LIGNE\nLes horaires indiquent le début des films. Vous pouvez réserver vos places jusqu'à 5 minutes avant le début de la séance. Annulation possible jusqu'à 15 minutes avant le début de la séance.\n\nACCESSIBILITÉ\nSalles accessibles aux personnes à mobilité réduite (PMR). Toutes les salles sont équipées pour l'audiodescription et l'amplification sonore pour malentendants (prêt de l'appareil en caisse, pièce d'identité en garantie ; munissez-vous de votre casque personnel).\n\nCONFISERIE (à retirer au stand confiserie)\nMenu Mini 4,50 € (1 soda + 1 pop mini) • Menu Petit solo 6,50 € • Menu Petit duo 8,50 € (2 boissons + 1 pop) • Menu Moyen solo 8,50 € • Menu Moyen duo 10,50 € • Menu Maxi solo 10,00 € • Menu Maxi duo 12,00 €.\nBoissons : Coca-Cola, Coca-Cola Zéro, Oasis Tropical, Orangina, Schweppes Agrumes, Coca Cherry, Lipton Ice Tea, eau San Pellegrino, Volvic citron/fraise.\n\nPOP-CORN ANTI-DÉCHETS\nApportez votre contenant et payez uniquement la recharge : mini 0,71 L, moyen 1,36 L, maxi 2,5 L.\n\nCARTE CINÉMA ET PASS 15/25\nGérez votre carte en ligne : places de cinéma, confiserie et cadeaux à gagner.";
async function ensure3(){
 const c=await Set.findOne();if(c.get("realdata"))return;
 for(const f of REAL){
  const ex=await M.films.findOne({title:f.title});
  if(!ex){await M.films.create({featured:false,...f});continue}
  const u={};for(const k in f)if(ex.get(k)==null||ex.get(k)==="")u[k]=f[k];
  if(Object.keys(u).length)await M.films.updateOne({_id:ex._id},{$set:u});
 }
 // Séances de Ducobu du 7 au 13 octobre 2026 (relevées sur le site officiel)
 const du=await M.films.findOne({title:"Ducobu et le fantôme de Saint-Potache"});
 if(du&&!(await M.seances.countDocuments({film:du._id,date:"2026-10-07"}))){
  const P={"2026-10-07":["14h00","16h30","19h00"],"2026-10-08":["14h00","16h30","19h00"],"2026-10-09":["14h00","16h30","19h00"],"2026-10-10":["16h30","19h00"],"2026-10-11":["14h00","16h30","19h00"],"2026-10-12":["14h00","16h30","19h00"],"2026-10-13":["10h00","16h30"]};
  const L=[];for(const d in P)for(const time of P[d])L.push({film:du._id,date:d,time,room:"",version:"VF"});
  await M.seances.create(L);
 }
 await Set.updateOne({_id:c._id},{$set:{prices:"Normal:9.00,Réduit:6.50,Carte jeune:6.50,Famille nombreuse:6.50,Senior:6.50,Étudiant:6.50,Moins de 18 ans:6.50",address:"6 place Charles de Gaulle, 33700 Mérignac",realdata:true}});
 const tx=async(t,x)=>{const p=await M.pages.findOne({title:t});if(p&&(!p.text||/Contenu à compléter/.test(p.text)))await M.pages.updateOne({_id:p._id},{$set:{text:x}})};
 await tx("Tarifs",TARIFS_TXT);await tx("Infos pratiques",INFOS_TXT);
}
mongoose.connect(MONGODB_URI).then(async()=>{if(!(await M.films.countDocuments()))await seed();await ensure();await ensure2();await ensure3();app.listen(PORT,()=>console.log("Ciné sur le port "+PORT))}).catch(e=>{console.error("MongoDB :",e.message);process.exit(1)});
