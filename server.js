require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors()); // Permite que Moodle se conecte sin bloqueos

// ================= DATOS DE TU PROYECTO =================
const CONTRACT_ADDRESS = "0x4A5340cBB1e2D000357880fFBaC8AA5B6Cf557fD"; 
const SHEET_ID = "15Xg4nlQIK6FCFrCAli8qgKvWtwtDzXjBmVFHwYgF2TI"; 

// CAMBIO: Usamos 1RPC, es muy rápido y gratuito para evitar bloqueos
const PROVIDER_URL = "https://1rpc.io/matic"; 
const PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY; 

const GID_INSIGNIAS = "1450605916"; 
const GID_USUARIOS = "351737717";   
// ========================================================

const CONTRACT_ABI = [
    "function mintInsignia(address to, uint256 id, uint256 amount) public",
    "function balanceOf(address account, uint256 id) public view returns (uint256)"
];

const provider = new ethers.JsonRpcProvider(PROVIDER_URL);

let wallet;
let contract;

// Validación inicial de la Wallet
if (PRIVATE_KEY) {
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
    console.log(`✅ BOT INICIADO. Wallet Admin: ${wallet.address}`);
} else {
    console.error("❌ ERROR CRÍTICO: No se encontró ADMIN_PRIVATE_KEY en las variables de Render.");
}

// === CACHÉ DE DATOS ===
let insigniasCache = {};
let lastUpdate = 0;

async function actualizarInsigniasDesdeSheet() {
    // Si la caché es reciente (menos de 60s), la usamos para no esperar a Google
    if (Date.now() - lastUpdate < 60000 && Object.keys(insigniasCache).length > 0) return insigniasCache;
    
    try {
        console.log("📥 Actualizando catálogo desde Google Sheets...");
        const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_INSIGNIAS}`;
        const response = await axios.get(url);
        const filas = response.data.split('\n');
        const nuevasInsignias = {};

        for (let i = 1; i < filas.length; i++) {
            const cols = filas[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (cols.length >= 4) {
                const id = cols[0]?.replace(/"/g, '').trim();
                if(id && !isNaN(id)) {
                    nuevasInsignias[id] = {
                        name: cols[1]?.replace(/"/g, '').trim(),
                        description: cols[2]?.replace(/"/g, '').trim(),
                        image: cols[3]?.replace(/"/g, '').trim()
                    };
                }
            }
        }
        insigniasCache = nuevasInsignias;
        lastUpdate = Date.now();
        console.log(`✅ Catálogo actualizado: ${Object.keys(nuevasInsignias).length} insignias.`);
        return nuevasInsignias;
    } catch (error) { 
        console.error("⚠️ Error leyendo Sheets, usando caché vieja:", error.message);
        return insigniasCache; 
    }
}

// Ruta de comprobación
app.get('/', (req, res) => res.send("✅ Servidor SST DAO Operativo v3.0 (Gas Force)"));

// === RUTA 1: CONSULTAR USUARIO ===
app.post('/api/consultar-usuario', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Falta email" });

    const urlUsers = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_USUARIOS}`; 
    try {
        const resp = await axios.get(urlUsers);
        const filas = resp.data.split('\n');
        
        let walletFound = null;
        let idsPermitidosString = ""; 
        const emailBuscado = email.trim().toLowerCase();

        for (let i = 1; i < filas.length; i++) {
            const cols = filas[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            // Estructura: Col B (1)=Email, Col C (2)=Wallet, Col G (6)=IDs
            if (cols.length >= 3) {
                const mailHoja = cols[1]?.replace(/"/g, '').trim().toLowerCase();
                if (mailHoja === emailBuscado) {
                    walletFound = cols[2]?.replace(/"/g, '').trim();
                    if (cols.length > 6) idsPermitidosString = cols[6]?.replace(/"/g, '').trim(); 
                    break;
                }
            }
        }

        if (!walletFound) return res.status(404).json({ error: "Usuario no encontrado en la base de datos." });

        const catalogoCompleto = await actualizarInsigniasDesdeSheet();
        const insigniasDelUsuario = {};

        // Filtramos las insignias permitidas
        if (idsPermitidosString) {
            const listaIDs = idsPermitidosString.split(',').map(id => id.trim());
            
            // Verificamos propiedad en paralelo (Más rápido)
            await Promise.all(listaIDs.map(async (id) => {
                if (catalogoCompleto[id]) {
                    insigniasDelUsuario[id] = { ...catalogoCompleto[id] };
                    insigniasDelUsuario[id].owned = false; 
                    if (contract) {
                        try {
                            const balance = await contract.balanceOf(walletFound, id);
                            if (balance > 0n) insigniasDelUsuario[id].owned = true;
                        } catch (err) { console.error(`Error verificando balance:`, err.message); }
                    }
                }
            }));
        }

        if (Object.keys(insigniasDelUsuario).length === 0) {
            return res.status(404).json({ error: "Usuario encontrado, pero no tiene insignias asignadas en la Columna G." });
        }

        res.json({ success: true, wallet: walletFound, badges: insigniasDelUsuario });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Error interno leyendo Excel." });
    }
});

// === RUTA 2: EMITIR (VERSIÓN FUERZA BRUTA) ===
app.post('/api/emitir-insignia', async (req, res) => {
    const { wallet: userWallet, badgeId } = req.body;
    
    if (!userWallet || !badgeId) return res.status(400).json({ error: "Datos incompletos" });
    if (!contract || !wallet) return res.status(500).json({ error: "Error interno: Sin wallet admin." });

    try {
        const insignias = await actualizarInsigniasDesdeSheet();
        const badgeData = insignias[badgeId];
        if (!badgeData) return res.status(404).json({ error: "Insignia no existe" });

        // 1. Verificamos si ya la tiene (lectura gratis)
        const balance = await contract.balanceOf(userWallet, badgeId);
        let txHash = "YA_EXISTE";

        if (balance > 0n) {
            console.log(`ℹ️ Usuario ya tiene la insignia ${badgeId}, no se emite.`);
        } else {
            console.log(`🚀 Emitiendo ID ${badgeId} a ${userWallet}...`);
            
            // 2. 🔥 EMISIÓN CON GAS LIMIT FORZADO 🔥
            // Esto evita que se quede "calculando gas" infinitamente
            const tx = await contract.mintInsignia(userWallet, badgeId, 1, {
                gasLimit: 500000 // Suficiente para cualquier operación simple
            });
            
            txHash = tx.hash;
            console.log(`✅ Transacción enviada a la red: ${txHash}`);
            // NO esperamos el wait() para responder rápido al usuario
        }

        const openSeaUrl = `https://opensea.io/assets/matic/${CONTRACT_ADDRESS}/${badgeId}`;
        const linkedinUrl = `https://www.linkedin.com/profile/add?startTask=CERTIFICATION_NAME&name=${encodeURIComponent(badgeData.name)}&organizationName=La%20Movida%20de%20SST%20DAO&issueYear=${new Date().getFullYear()}&certUrl=${encodeURIComponent(openSeaUrl)}&certId=${txHash}`;

        res.json({
            success: true,
            txHash: txHash,
            opensea: openSeaUrl,
            linkedin: linkedinUrl,
            image: badgeData.image,
            alreadyOwned: (balance > 0n)
        });

    } catch (error) {
        console.error("❌ Error Blockchain:", error);
        
        let msg = "Error desconocido";
        if (error.code === 'INSUFFICIENT_FUNDS' || error.message.includes('funds')) {
            msg = "El servidor se quedó sin Gas (MATIC).";
        } else if (error.reason) {
            msg = error.reason;
        } else if (error.message) {
            msg = error.message;
        }

        res.status(500).json({ error: "Fallo Blockchain: " + msg });
    }
});

app.get('/api/metadata/:id.json', async (req, res) => {
    const id = req.params.id;
    const insignias = await actualizarInsigniasDesdeSheet();
    const badge = insignias[id];
    if (!badge) return res.status(404).json({ error: "No encontrada" });
    res.json({ name: badge.name, description: badge.description, image: badge.image });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor listo en puerto ${PORT}`));
