require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

// ================= DATOS DE TU PROYECTO =================
// ✅ NUEVA DIRECCIÓN DEL CONTRATO (SSTBadge_v2)
const CONTRACT_ADDRESS = "0xE0E07Bbdc1fEeFf774b5F40E856cE2A218501167"; 

const SHEET_ID = "15Xg4nlQIK6FCFrCAli8qgKvWtwtDzXjBmVFHwYgF2TI"; 
// GIDs (IDs de las pestañas del Excel)
const GID_INSIGNIAS = "1450605916"; 
const GID_USUARIOS = "351737717";   

// Usamos ANKR (Estable y Rápido)
const PROVIDER_URL = "https://rpc.ankr.com/polygon"; 
const PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY; 
// ======================================================

// ABI LIMPIO Y CORRECTO
const CONTRACT_ABI = [
    "function mintInsignia(address to, uint256 id, uint256 amount) public",
    "function balanceOf(address account, uint256 id) public view returns (uint256)"
];

// Validación de Entorno
if (!PRIVATE_KEY) {
    console.error("🚨 ERROR CRÍTICO: Falta ADMIN_PRIVATE_KEY. El servidor no podrá firmar.");
}

const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
let wallet, contract;

if (PRIVATE_KEY) {
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
    console.log(`🛡️ SISTEMA ONLINE. Wallet Admin: ${wallet.address}`);
    console.log(`📝 Contrato: ${CONTRACT_ADDRESS}`);
}

// === CACHÉ RESILIENTE ===
let insigniasCache = {};
let lastUpdate = 0;

async function actualizarInsigniasDesdeSheet() {
    // Si la caché es fresca (menos de 2 min), úsala.
    if (Date.now() - lastUpdate < 120000 && Object.keys(insigniasCache).length > 0) {
        return insigniasCache;
    }
    
    try {
        console.log("📥 Sincronizando con Google Sheets...");
        const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_INSIGNIAS}`;
        const response = await axios.get(url, { timeout: 5000 }); // Timeout de 5s
        
        const filas = response.data.split('\n');
        const nuevasInsignias = {};

        for (let i = 1; i < filas.length; i++) {
            // Regex para separar CSV respetando comillas
            const cols = filas[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (cols.length >= 4) {
                const idRaw = cols[0]?.replace(/"/g, '').trim();
                // Validar que sea un número real
                if (idRaw && /^\d+$/.test(idRaw)) {
                    nuevasInsignias[idRaw] = {
                        name: cols[1]?.replace(/"/g, '').trim(),
                        description: cols[2]?.replace(/"/g, '').trim(),
                        image: cols[3]?.replace(/"/g, '').trim()
                    };
                }
            }
        }
        
        if (Object.keys(nuevasInsignias).length > 0) {
            insigniasCache = nuevasInsignias;
            lastUpdate = Date.now();
            console.log(`✅ Caché actualizada: ${Object.keys(insigniasCache).length} items.`);
        }
        return insigniasCache;

    } catch (error) { 
        console.error("⚠️ Falló actualización de Sheet. Usando caché anterior.", error.message);
        return insigniasCache; 
    }
}

// === RUTA BASE ===
app.get('/', (req, res) => res.send("✅ Servidor SST DAO Activo (Contrato v2)."));

// === RUTA 1: CONSULTAR USUARIO ===
app.post('/api/consultar-usuario', async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: "Email inválido" });

    try {
        const urlUsers = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_USUARIOS}`; 
        const resp = await axios.get(urlUsers, { timeout: 5000 });
        const filas = resp.data.split('\n');
        
        let walletFound = null;
        let idsPermitidos = [];
        const emailBuscado = email.trim().toLowerCase();

        for (let i = 1; i < filas.length; i++) {
            const cols = filas[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (cols.length >= 3) {
                const mailHoja = cols[1]?.replace(/"/g, '').trim().toLowerCase();
                
                if (mailHoja === emailBuscado) {
                    const rawWallet = cols[2]?.replace(/"/g, '').trim();
                    
                    if (ethers.isAddress(rawWallet)) {
                        walletFound = rawWallet;
                        
                        if (cols.length > 6) {
                            const rawIds = cols[6]?.replace(/"/g, '').trim();
                            if (rawIds) {
                                // Filtramos solo números válidos
                                idsPermitidos = rawIds.split(',').map(id => id.trim()).filter(id => /^\d+$/.test(id));
                            }
                        }
                    }
                    break;
                }
            }
        }

        if (!walletFound) return res.status(404).json({ error: "Usuario no encontrado o Wallet inválida en el Excel." });

        const catalogo = await actualizarInsigniasDesdeSheet();
        const insigniasUsuario = {};

        // Verificamos estado en Blockchain
        if (idsPermitidos.length > 0) {
            await Promise.all(idsPermitidos.map(async (id) => {
                if (catalogo[id]) {
                    insigniasUsuario[id] = { ...catalogo[id], owned: false };
                    try {
                        if (contract) {
                            const idBN = BigInt(id);
                            const balance = await contract.balanceOf(walletFound, idBN);
                            if (balance > 0n) insigniasUsuario[id].owned = true;
                        }
                    } catch (err) {
                        console.warn(`Error leyendo balance ID ${id}: ${err.message}`);
                    }
                }
            }));
        }

        if (Object.keys(insigniasUsuario).length === 0) {
            return res.status(404).json({ error: "Usuario encontrado, pero sin insignias asignadas." });
        }

        res.json({ success: true, wallet: walletFound, badges: insigniasUsuario });

    } catch (e) {
        console.error("Error en consulta:", e);
        res.status(500).json({ error: "Error interno del servidor." });
    }
});

// === RUTA 2: EMITIR (Idempotente y Rápida) ===
app.post('/api/emitir-insignia', async (req, res) => {
    const { wallet: userWallet, badgeId } = req.body;

    if (!userWallet || !ethers.isAddress(userWallet)) return res.status(400).json({ error: "Wallet inválida." });
    if (!badgeId) return res.status(400).json({ error: "Falta Badge ID." });
    if (!contract) return res.status(500).json({ error: "Error interno: Sin wallet admin." });

    try {
        const idBN = BigInt(badgeId); 
        const catalogo = await actualizarInsigniasDesdeSheet();
        const badgeData = catalogo[badgeId];

        if (!badgeData) return res.status(404).json({ error: "Insignia no existe en el catálogo." });

        console.log(`🤖 Procesando: ID ${idBN} -> ${userWallet}`);

        // IDEMPOTENCIA
        let balance = 0n;
        try {
            balance = await contract.balanceOf(userWallet, idBN);
        } catch(err) {
            console.log("⚠️ No se pudo leer balance, procediendo a emitir por si acaso.");
        }
        
        if (balance > 0n) {
            console.log(`ℹ️ Omitiendo mint: Ya la tiene.`);
            return res.json({
                success: true,
                alreadyOwned: true,
                opensea: `https://opensea.io/assets/matic/${CONTRACT_ADDRESS}/${badgeId}`,
                linkedin: null
            });
        }

        // EJECUCIÓN (Modo Turbo - Fire & Forget)
        const tx = await contract.mintInsignia(userWallet, idBN, 1, { gasLimit: 500000 });
        console.log(`✅ Tx Enviada: ${tx.hash}`);

        const openSeaUrl = `https://opensea.io/assets/matic/${CONTRACT_ADDRESS}/${badgeId}`;
        const linkedinUrl = `https://www.linkedin.com/profile/add?startTask=CERTIFICATION_NAME&name=${encodeURIComponent(badgeData.name)}&organizationName=La%20Movida%20de%20SST%20DAO&issueYear=${new Date().getFullYear()}&certUrl=${encodeURIComponent(openSeaUrl)}&certId=${tx.hash}`;

        res.json({
            success: true,
            alreadyOwned: false,
            txHash: tx.hash,
            opensea: openSeaUrl,
            linkedin: linkedinUrl,
            image: badgeData.image
        });

    } catch (error) {
        console.error("❌ Error Crítico:", error);
        
        let msg = "Error desconocido.";
        if (error.code === 'INSUFFICIENT_FUNDS') msg = "La DAO no tiene fondos (MATIC).";
        else if (error.message) msg = error.message;
        
        res.status(500).json({ error: msg });
    }
});

// Metadata endpoint (OpenSea llama a esto)
app.get('/api/metadata/:id.json', async (req, res) => {
    let id = req.params.id;
    
    // Traductor Hexadecimal para OpenSea
    if (id.length > 10) {
        try { id = BigInt(id).toString(); } catch(e) {}
    }

    const catalogo = await actualizarInsigniasDesdeSheet();
    const badge = catalogo[id];
    
    if (!badge) return res.status(404).json({ error: "Not found" });
    
    res.json({ 
        name: badge.name, 
        description: badge.description, 
        image: badge.image,
        external_url: "https://motor-sst.onrender.com"
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor listo en ${PORT}`));
