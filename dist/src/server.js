"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const auth_1 = require("./routes/auth");
const staffAuth_1 = require("./routes/staffAuth");
const customerAuth_1 = require("./routes/customerAuth");
const customerOrders_1 = require("./routes/customerOrders");
const customerPickups_1 = require("./routes/customerPickups");
const staffUsers_1 = require("./routes/staffUsers");
const pickups_1 = require("./routes/pickups");
const acumatica_1 = require("./routes/acumatica");
const publicAppointments_1 = require("./routes/publicAppointments");
const app = (0, express_1.default)();
const frontend = process.env.FRONTEND_URL ?? "https://mld-willcall.vercel.app";
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)({
    origin: frontend,
    credentials: true
}));
app.use(express_1.default.json({ limit: "1mb" }));
app.get("/health", (_req, res) => res.json({ ok: true }));
// Auth (password reset)
app.use("/api/auth", auth_1.authRouter);
// Staff auth
app.use("/api/staff", staffAuth_1.staffAuthRouter);
// Customer auth
app.use("/api/customer", customerAuth_1.customerAuthRouter);
// Customer orders
app.use("/api/customer/orders", customerOrders_1.customerOrdersRouter);
// Customer pickups
app.use("/api/customer/pickups", customerPickups_1.customerPickupsRouter);
// Public appointments (secure link)
app.use("/api/public/appointments", publicAppointments_1.publicAppointmentsRouter);
// Admin user management
app.use("/api/staff/users", staffUsers_1.staffUsersRouter);
// Pickups
app.use("/api/staff/pickups", pickups_1.pickupsRouter);
// Acumatica
app.use("/api/acumatica", acumatica_1.acumaticaRouter);
app.use((req, res) => {
    res.status(404).json({ message: "Not found" });
});
const port = Number(process.env.PORT ?? "5000");
app.listen(port, () => {
    console.log(`mld-willcall-backend listening on :${port}`);
});
