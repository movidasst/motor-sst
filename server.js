require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

// ================= DATOS DEL PROYECTO =================
const CONTRACT_ADDRESS = "0xE0E07Bbdc1fEeFf774b5F40E856cE2A218501167"; 
const SHEET_ID = "15Xg4nlQIK6FCFrCAli8qgKvWtwtDzXjBmVFHwYgF2TI"; 
const GID_INSIGNIAS = "1450605916"; 
const GID_USUARIOS = "351737717";   
const COMPANY_ID = "80061757"; // ID oficial de La Movida de SST en LinkedIn

const PROVIDER_URL = "https://polygon-rpc.com"; 
const PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY; 
// ======================================================

const CONTRACT_ABI = [
    "function mintInsignia(address to, uint256 id, uint256 amount) public",
    "function balanceOf(address account, uint256 id) public view returns (uint256)"
];

if (!PRIVATE_KEY) {
    console.error("🚨 CRITICAL: Falta ADMIN_PRIVATE_KEY.");
    process.exit(1);
}

const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

console.log(`🛡️ SISTEMA ENTERPRISE ONLINE. Wallet: ${wallet.address}`);

// === CACHÉ ===
let insigniasCache = {};
let lastUpdate = 0;

async function actualizarInsigniasDesdeSheet() {
    if (Date.now() - lastUpdate < 60000 && Object.keys(insigniasCache).length > 0) return insigniasCache;
    try {
        const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_INSIGNIAS}`;
        const response = await axios.get(url, { timeout: 8000 });
        
        const filas = response.data.split('\n');
        const nuevasInsignias = {};

        for (let i = 1; i < filas.length; i++) {
            const cols = filas[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (cols.length >= 4) {
                const idRaw = cols[0]?.replace(/"/g, '').trim();
                if (idRaw) {
                    nuevasInsignias[idRaw] = {
                        id: idRaw,
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
        }
        return insigniasCache;
    } catch (error) { 
        console.error("⚠️ Falló actualización Sheet:", error.message);
        return insigniasCache; 
    }
}

// Función para el link de LinkedIn
function buildLinkedInLink(name, badgeId, certUrl, txHash = null) {
    const certId = txHash || `${CONTRACT_ADDRESS}-${badgeId}`;
    const baseUrl = "https://www.linkedin.com/profile/add?startTask=CERTIFICATION_NAME";
    const params = [
        `name=${encodeURIComponent(name)}`,
        `organizationId=${COMPANY_ID}`,
        `certId=${encodeURIComponent(certId)}`,
        `certUrl=${encodeURIComponent(certUrl)}`,
        `issueYear=${new Date().getFullYear()}`,
        `issueMonth=${new Date().getMonth() + 1}`
    ];
    return `${baseUrl}&${params.join('&')}`;
}

app.get('/', (req, res) => res.send("✅ Servidor SST DAO Activo (v7.2 Fixed Multi-Badge)."));

// === RUTA 1: CONSULTAR USUARIO ===
app.post('/api/consultar-usuario', async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: "Email inválido" });

    try {
        const urlUsers = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_USUARIOS}`; 
        const resp = await axios.get(urlUsers, { timeout: 8000 });
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
                            // CORRECCIÓN: Split flexible para aceptar "1,2,3" o "1, 2, 3" o "1;2"
                            if (rawIds) idsPermitidos = rawIds.split(/[ ,;]+/).map(id => id.trim()).filter(id => id !== "");
                        }
                    }
                    break;
                }
            }
        }

        if (!walletFound) return res.status(404).json({ error: "Usuario no encontrado." });

        const catalogo = await actualizarInsigniasDesdeSheet();
        const insigniasUsuario = {};

        for (const id of idsPermitidos) {
            const bData = catalogo[id];
            if (bData) {
                insigniasUsuario[id] = { ...bData, owned: false };
                const osUrl = `https://opensea.io/assets/polygon/${CONTRACT_ADDRESS}/${id}`;
                insigniasUsuario[id].linkedin = buildLinkedInLink(bData.name, id, osUrl);

                try {
                    const balance = await contract.balanceOf(walletFound, id);
                    if (balance > 0n) insigniasUsuario[id].owned = true;
                } catch (err) {
                    console.warn(`Balance check failed for ID ${id}`);
                }
            }
        }

        if (Object.keys(insigniasUsuario).length === 0) return res.status(404).json({ error: "No tienes insignias asignadas." });

        res.json({ success: true, wallet: walletFound, badges: insigniasUsuario });

    } catch (e) {
        console.error("Error consulta:", e);
        res.status(500).json({ error: "Error interno del servidor." });
    }
});

// === RUTA 2: EMITIR ===
app.post('/api/emitir-insignia', async (req, res) => {
    const { wallet: userWallet, badgeId } = req.body;

    if (!userWallet || !ethers.isAddress(userWallet)) return res.status(400).json({ error: "Wallet inválida." });
    if (!badgeId) return res.status(400).json({ error: "Falta ID." });

    try {
        const catalogo = await actualizarInsigniasDesdeSheet();
        const badgeData = catalogo[badgeId];

        if (!badgeData) return res.status(404).json({ error: "La insignia no existe en la Sheet." });

        const estimate = await contract.getFunction("mintInsignia(address,uint256,uint256)").estimateGas(userWallet, badgeId, 1);
        const gasLimit = (estimate * 130n) / 100n; // 30% buffer para mayor seguridad
        
        const tx = await contract.getFunction("mintInsignia(address,uint256,uint256)")(userWallet, badgeId, 1, { gasLimit });
        
        const openSeaUrl = `https://opensea.io/assets/polygon/${CONTRACT_ADDRESS}/${badgeId}`;
        const linkedinUrl = buildLinkedInLink(badgeData.name, badgeId, openSeaUrl, tx.hash);

        res.json({
            success: true,
            txHash: tx.hash,
            opensea: openSeaUrl,
            linkedin: linkedinUrl,
            image: badgeData.image
        });

    } catch (error) {
        console.error("❌ Error emisión:", error);
        res.status(500).json({ error: "Error de Blockchain: " + (error.message || "Fallo en la transacción") });
    }
});

// === RUTA 3: METADATOS ===
app.get('/api/metadata/:id.json', async (req, res) => {
    let id = req.params.id;
    if (id.startsWith('0x')) { try { id = BigInt(id).toString(); } catch(e) {} }

    const catalogo = await actualizarInsigniasDesdeSheet();
    const badge = catalogo[id];
    
    if (!badge) return res.status(404).json({ error: "Not found" });
    
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
        name: badge.name, 
        description: badge.description, 
        image: badge.image,
        external_url: "https://dao.movidasst.com",
        attributes: [
            { "trait_type": "Emisor", "value": "La Movida de SST DAO" },
            { "trait_type": "ID Credencial", "value": `${CONTRACT_ADDRESS}-${id}` }
        ]
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor Enterprise v7.2 listo.`));
