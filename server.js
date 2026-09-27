
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(path.join(__dirname, "malak_altamia.sqlite3"));
db.pragma("foreign_keys = ON");

const allowedStatuses = new Set([
  "new","accepted","preparing","ready","out_for_delivery","delivered","cancelled"
]);

function shopOpen() {
  const now = new Date();
  // Sudan is UTC+2.
  const sudan = new Date(now.getTime() + 2*60*60*1000);
  const day = sudan.getUTCDay(); // Friday = 5
  const hour = sudan.getUTCHours();
  return day !== 5 && hour >= 6 && hour < 19;
}

app.get("/api/health", (req,res) => res.json({ok:true, service:"ملك الطعمية API"}));

app.get("/api/shop", (req,res) => {
  const shop = db.prepare("SELECT * FROM shop_settings WHERE id=1").get();
  res.json({...shop, open_now: shopOpen()});
});

app.get("/api/products", (req,res) => {
  res.json(db.prepare("SELECT * FROM products WHERE available=1 ORDER BY quantity").all());
});

app.get("/api/addons", (req,res) => {
  res.json(db.prepare("SELECT * FROM addons WHERE available=1 ORDER BY id").all());
});

app.post("/api/orders", (req,res) => {
  const {name, phone, whatsapp="", address="", order_type="delivery",
          product_id, quantity=1, addon_ids=[], notes=""} = req.body;

  if (!name || !phone || !product_id) {
    return res.status(400).json({error:"الاسم ورقم الهاتف والصنف مطلوبة"});
  }
  if (!shopOpen()) return res.status(403).json({error:"المحل مغلق حالياً"});

  const product = db.prepare("SELECT * FROM products WHERE id=? AND available=1").get(product_id);
  if (!product) return res.status(400).json({error:"الصنف غير متوفر"});

  const addons = addon_ids.length
    ? db.prepare(`SELECT * FROM addons WHERE available=1 AND id IN (${addon_ids.map(()=>"?").join(",")})`).all(...addon_ids)
    : [];

  const deliveryFee = order_type === "delivery" ? 3000 : 0;
  const total = product.price * quantity + addons.reduce((s,a)=>s+a.price,0) + deliveryFee;

  const tx = db.transaction(() => {
    let customer = db.prepare("SELECT id FROM customers WHERE phone=?").get(phone);
    if (!customer) {
      const r = db.prepare("INSERT INTO customers(name,phone,whatsapp,address) VALUES(?,?,?,?)")
        .run(name,phone,whatsapp,address);
      customer = {id:r.lastInsertRowid};
    } else {
      db.prepare("UPDATE customers SET name=?, whatsapp=?, address=? WHERE id=?")
        .run(name,whatsapp,address,customer.id);
    }

    const order = db.prepare(
      "INSERT INTO orders(customer_id,order_type,delivery_fee,total,status,notes) VALUES(?,?,?,?,?,?)"
    ).run(customer.id,order_type,deliveryFee,total,"new",notes);

    db.prepare(
      "INSERT INTO order_items(order_id,product_id,quantity,unit_price) VALUES(?,?,?,?)"
    ).run(order.lastInsertRowid,product.id,quantity,product.price);

    const addStmt = db.prepare(
      "INSERT INTO order_addons(order_id,addon_id,quantity,unit_price) VALUES(?,?,1,?)"
    );
    for (const a of addons) addStmt.run(order.lastInsertRowid,a.id,a.price);

    return order.lastInsertRowid;
  });

  const id = tx();
  res.status(201).json({order_id:id, total, status:"new"});
});

app.get("/api/orders", (req,res) => {
  const rows = db.prepare(`
    SELECT o.*, c.name customer_name, c.phone customer_phone, c.whatsapp,
           c.address customer_address
    FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
    ORDER BY o.id DESC
  `).all();
  res.json(rows);
});

app.get("/api/orders/:id", (req,res) => {
  const o = db.prepare(`
    SELECT o.*, c.name customer_name, c.phone customer_phone, c.whatsapp,
           c.address customer_address
    FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
    WHERE o.id=?
  `).get(req.params.id);
  if (!o) return res.status(404).json({error:"الطلب غير موجود"});

  o.items = db.prepare(`
    SELECT oi.*, p.name, p.quantity product_quantity
    FROM order_items oi JOIN products p ON p.id=oi.product_id
    WHERE oi.order_id=?
  `).all(req.params.id);

  o.addons = db.prepare(`
    SELECT oa.*, a.name FROM order_addons oa JOIN addons a ON a.id=oa.addon_id
    WHERE oa.order_id=?
  `).all(req.params.id);

  res.json(o);
});

app.patch("/api/orders/:id/status", (req,res) => {
  const {status} = req.body;
  if (!allowedStatuses.has(status)) return res.status(400).json({error:"حالة غير صحيحة"});
  const r = db.prepare("UPDATE orders SET status=? WHERE id=?").run(status,req.params.id);
  if (!r.changes) return res.status(404).json({error:"الطلب غير موجود"});
  res.json({order_id:Number(req.params.id),status});
});

app.get("/api/reports/today", (req,res) => {
  const r = db.prepare(`
    SELECT COUNT(*) orders_count,
           COALESCE(SUM(total),0) revenue,
           COALESCE(SUM(delivery_fee),0) delivery_revenue
    FROM orders
    WHERE date(created_at)=date('now','localtime') AND status!='cancelled'
  `).get();
  res.json(r);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("ملك الطعمية API running");
});
