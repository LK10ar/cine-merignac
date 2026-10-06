const express = require("express"), mongoose = require("mongoose"), crypto = require("crypto"), path = require("path");
const { MONGODB_URI, ADMIN_PASSWORD, TOKEN_SECRET = "change-me", PORT = 3000 } = process.env;
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_, res) => res.send("ok"));

const sch = (o) => new mongoose.Schema(o, { timestamps: true });
const M = {
  films: mongoose.model("Film", sch({ title: { type: String, required: true }, duration: String, rating: String, genre: String, director: String, cast: String, synopsis: String, poster: String, backdrop: String, trailer: String, releaseDate: String, status: { type: String, enum: ["new", "old", "soon"], default: "old" }, featured: Boolean })),
  seances: mongoose.model("Seance", sch({ film: { type: mongoose.Schema.Types.ObjectId, ref: "Film", required: true }, date: { type: String, required: true }, time: { type: String, required: true }, room: String, version: { type: String, default: "VF" }, thx: Boolean })),
  events: mongoose.model("Event", sch({ title: { type: String, required: true }, label: String, text: String, date: String, image: String, filmId: String, featured: Boolean })),
};

// Auth admin : mot de passe -> jeton signé HMAC (12 h)
const sign = (d) => crypto.createHmac("sha256", TOKEN_SECRET).update(d).digest("base64url");
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const tries = new Map();
app.post("/api/login", (req, res) => {
  const t = tries.get(req.ip) || { n: 0, r: Date.now() + 9e5 };
  if (Date.now() > t.r) { t.n = 0; t.r = Date.now() + 9e5; }
  if (t.n >= 10) return res.status(429).json({ error: "Trop d'essais, réessayez plus tard" });
  t.n++; tries.set(req.ip, t);
  const pw = String(req.body.password || "");
  if (!ADMIN_PASSWORD || !same(pw, ADMIN_PASSWORD)) return res.status(401).json({ error: "Mot de passe incorrect" });
  const p = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 36e5 })).toString("base64url");
  res.json({ token: p + "." + sign(p) });
});
const auth = (req, res, next) => {
  const [p, s] = (req.headers.authorization || "").replace("Bearer ", "").split(".");
  try { if (p && s && same(s, sign(p)) && JSON.parse(Buffer.from(p, "base64url")).exp > Date.now()) return next(); } catch {}
  res.status(401).json({ error: "Non autorisé" });
};

// CRUD : lecture publique, écriture réservée à l'admin
for (const [name, Model] of Object.entries(M)) {
  const r = express.Router();
  r.get("/", async (req, res) => {
    const q = req.query.film ? { film: req.query.film } : {};
    res.json(await Model.find(q).sort(name === "seances" ? { date: 1, time: 1 } : { createdAt: -1 }));
  });
  r.post("/", auth, async (req, res) => { try { res.status(201).json(await Model.create(req.body)); } catch (e) { res.status(400).json({ error: e.message }); } });
  r.put("/:id", auth, async (req, res) => { try { res.json(await Model.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })); } catch (e) { res.status(400).json({ error: e.message }); } });
  r.delete("/:id", auth, async (req, res) => {
    await Model.findByIdAndDelete(req.params.id);
    if (name === "films") await M.seances.deleteMany({ film: req.params.id });
    res.json({ ok: true });
  });
  app.use("/api/" + name, r);
}

async function seed() {
  const f = await M.films.create([
    { title: "Ducobu et le fantôme de Saint-Potache", duration: "1h30", rating: "Tous publics", genre: "Comédie, Famille", director: "Elie Semoun", status: "new", featured: true },
    { title: "Pressure", duration: "1h40", rating: "Tous publics", genre: "Thriller, Historique, Guerre", director: "Anthony Maras", status: "old", featured: true },
    { title: "Mochy, le chien le plus moche du monde", duration: "1h25", genre: "Animation", status: "soon" },
  ]);
  const d = new Date(), k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  await M.seances.create(["14h00", "16h30", "19h00"].map((time) => ({ film: f[0]._id, date: k, time, room: "Salle 1" })));
  await M.events.create({ title: "Un bon patron", label: "Avant-première", date: "23 oct.", text: "Soirée en présence de Didier Bourdon et Philippe de Chauveron, à 19h." });
}
mongoose.connect(MONGODB_URI).then(async () => {
  if (!(await M.films.countDocuments())) await seed();
  app.listen(PORT, () => console.log("Ciné Mérignac sur le port " + PORT));
}).catch((e) => { console.error("MongoDB :", e.message); process.exit(1); });
