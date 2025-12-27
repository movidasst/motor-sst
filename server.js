require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

// ================= DATOS =================
const CONTRACT_ADDRESS = "0x4A5340cBB1e2D000357880fFBaC8AA5B6Cf557fD"; 
const SHEET_ID = "15Xg4nlQIK6FCFrCAli8qgKvWtwtDzXjBmVFHwYgF2TI"; 

// 🔥 CAMBIO CRÍTICO: Usamos ANKR. Es el RPC más rápido y estable.
const PROVIDER_URL = "https://rpc.ankr.com/polygon"; 
const PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY; 

const GID_INSIGNIAS = "1450605916"; 
const GID_USUARIOS = "351737717";   
// =========================================

const CONTRACT_ABI = [
    "function mintInsignia(address to, uint256 id, uint256 amount) public",
    "function balanceOf(address account, uint256 id) public view returns (uint256)"
];

// Configuración Ethers v6
const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
let wallet, contract;

if (PRIVATE_KEY) {
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
    console.log(`✅ BOT ACTIVO (ANKR). Wallet: ${wallet.address}`);
} else {
    console.error("❌ ERROR: Falta ADMIN_PRIVATE_KEY.");
}

// === CACHÉ GOOGLE SHEETS ===
let insigniasCache = {};
let lastUpdate = 0;

async function actualizarInsigniasDesdeSheet() {
    if (Date.now() - lastUpdate < 60000 && Object.keys(insigniasCache).length > 0) return insigniasCache;
    try {
        console.log("📥 Leyendo Google Sheets...");
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
        return nuevasInsignias;
    } catch (error) { return insigniasCache; }
}

// === RUTA PRINCIPAL ===
app.get('/', (req, res) => res.send("✅ Servidor SST Online (ANKR)."));

// === RUTA 1: CONSULTAR (RÁPIDA) ===
app.post('/api/consultar-usuario', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Falta email" });

    // 1. Buscamos en Google Sheets
    const urlUsers = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_USUARIOS}`; 
    try {
        const resp = await axios.get(urlUsers);
        const filas = resp.data.split('\n');
        let walletFound = null;
        let idsPermitidosString = ""; 
        const emailBuscado = email.trim().toLowerCase();

        for (let i = 1; i < filas.length; i++) {
            const cols = filas[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (cols.length >= 3) {
                const mailHoja = cols[1]?.replace(/"/g, '').trim().toLowerCase();
                if (mailHoja === emailBuscado) {
                    walletFound = cols[2]?.replace(/"/g, '').trim();
                    if (cols.length > 6) idsPermitidosString = cols[6]?.replace(/"/g, '').trim(); 
                    break;
                }
            }
        }

        if (!walletFound) return res.status(404).json({ error: "Usuario no encontrado." });

        // 2. Traemos catálogo
        const catalogo = await actualizarInsigniasDesdeSheet();
        const insigniasUsuario = {};

        // 3. Verificamos Blockchain en Paralelo (Para pintar botón azul/verde)
        if (idsPermitidosString) {
            const listaIDs = idsPermitidosString.split(',').map(id => id.trim());
            
            // Usamos Promise.all para preguntar por todas a la vez
            await Promise.all(listaIDs.map(async (id) => {
                if (catalogo[id]) {
                    insigniasUsuario[id] = { ...catalogo[id] };
                    insigniasUsuario[id].owned = false; 
                    if (contract) {
                        try {
                            const balance = await contract.balanceOf(walletFound, id);
                            if (balance > 0n) insigniasUsuario[id].owned = true;
                        } catch (err) { console.error(`Error leyendo balance ${id}:`, err.message); }
                    }
                }
            }));
        }

        if (Object.keys(insigniasUsuario).length === 0) return res.status(404).json({ error: "Sin insignias asignadas." });

        res.json({ success: true, wallet: walletFound, badges: insigniasUsuario });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Error leyendo Excel." });
    }
});

// === RUTA 2: EMITIR (MODO TURBO - DISPARAR Y OLVIDAR) ===
app.post('/api/emitir-insignia', async (req, res) => {
    const { wallet: userWallet, badgeId } = req.body;
    
    if (!userWallet || !badgeId) return res.status(400).json({ error: "Datos incompletos" });
    if (!contract) return res.status(500).json({ error: "Error interno: Sin contrato." });

    try {
        console.log(`🚀 Iniciando emisión ID ${badgeId} para ${userWallet}...`);
        
        const catalogo = await actualizarInsigniasDesdeSheet();
        const badgeData = catalogo[badgeId];
        if (!badgeData) return res.status(404).json({ error: "ID de insignia no existe" });

        // 1. Verificación rápida de propiedad
        const balance = await contract.balanceOf(userWallet, badgeId);
        
        let txHash = "YA_EXISTE";

        if (balance > 0n) {
            console.log(`ℹ️ Usuario ya tiene la insignia.`);
        } else {
            // 2. EMISIÓN FUERZA BRUTA
            // Gas Limit alto (500k) para que no calcule nada y entre directo
            // SIN 'await tx.wait()' para responder en 0.5 segundos
            const tx = await contract.mintInsignia(userWallet, badgeId, 1, {
                gasLimit: 500000 
            });
            txHash = tx.hash;
            console.log(`✅ Tx enviada a la mempool: ${txHash}`);
        }

        // 3. Respuesta Inmediata
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
        res.status(500).json({ error: "Fallo Blockchain: " + (error.shortMessage || error.message) });
    }
});

// Metadata para OpenSea
app.get('/api/metadata/:id.json', async (req, res) => {
    const id = req.params.id;
    const catalogo = await actualizarInsigniasDesdeSheet();
    const badge = catalogo[id];
    if (!badge) return res.status(404).json({ error: "No encontrada" });
    res.json({ name: badge.name, description: badge.description, image: badge.image });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor listo en puerto ${PORT}`));
