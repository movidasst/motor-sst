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
    console.error("🚨 ERROR: ADMIN_PRIVATE_KEY no configurada.");
    process.exit(1);
}

const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

console.log(`🛡️ MOTOR SST ACTIVO v9.5 (CSV Parser Pro). Wallet: ${wallet.address}`);

// === PARSER CSV ROBUSTO (Maneja saltos de línea dentro de celdas) ===
function parseCSV(text) {
    const rows = [];
    let currentRow = [];
    let currentCell = '';
    let insideQuotes = false;
    
    // Normalizar saltos de línea
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];
        
        if (char === '"') {
            if (insideQuotes && nextChar === '"') {
                currentCell += '"'; // Comilla escapada
                i++;
            } else {
                insideQuotes = !insideQuotes;
            }
        } else if (char === ',' && !insideQuotes) {
            currentRow.push(currentCell); // No hacemos trim aquí para no romper datos
            currentCell = '';
        } else if (char === '\n' && !insideQuotes) {
            currentRow.push(currentCell);
            if (currentRow.length > 0) rows.push(currentRow);
            currentRow = [];
            currentCell = '';
        } else {
            currentCell += char;
        }
    }
    // Agregar última fila si existe
    if (currentCell || currentRow.length > 0) {
        currentRow.push(currentCell);
        rows.push(currentRow);
    }
    return rows;
}

// === CACHÉ ===
let insigniasCache = {};
let lastUpdate = 0;

async function actualizarInsigniasDesdeSheet() {
    if (Date.now() - lastUpdate < 60000 && Object.keys(insigniasCache).length > 0) return insigniasCache;
    try {
        console.log("📥 Sincronizando catálogo de insignias...");
        const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_INSIGNIAS}`;
        const response = await axios.get(url, { timeout: 8000 });
        
        // USAMOS EL PARSER ROBUSTO AQUÍ
        const filas = parseCSV(response.data);
        const nuevasInsignias = {};

        // Empezamos en 0 para no perder nada, el regex filtra los títulos
        for (let i = 0; i < filas.length; i++) {
            const cols = filas[i];
            if (cols.length >= 4) {
                // Limpieza manual de comillas residuales y espacios
                const idRaw = cols[0].trim().replace(/^"|"$/g, '');
                
                // Si es un número válido, lo procesamos
                if (idRaw && /^\d+$/.test(idRaw)) {
                    nuevasInsignias[idRaw] = {
                        id: idRaw,
                        name: cols[1].trim().replace(/^"|"$/g, ''),
                        description: cols[2].trim().replace(/^"|"$/g, ''), // Aquí entra la descripción larga sin romper nada
                        image: cols[3].trim().replace(/^"|"$/g, '')
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

app.get('/', (req, res) => res.send("✅ Servidor SST DAO Activo (v9.5)."));

// === RUTA 1: CONSULTAR USUARIO ===
app.post('/api/consultar-usuario', async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: "Email inválido" });

    try {
        const urlUsers = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_USUARIOS}`; 
        const resp = await axios.get(urlUsers, { timeout: 8000 });
        
        // USAMOS EL PARSER ROBUSTO TAMBIÉN AQUÍ
        const filas = parseCSV(resp.data);
        
        let walletFound = null;
        let idsPermitidos = [];
        const emailBuscado = email.trim().toLowerCase();

        for (let i = 0; i < filas.length; i++) {
            const cols = filas[i];
            if (cols.length >= 3) {
                const mailHoja = cols[1].trim().toLowerCase().replace(/^"|"$/g, '');
                if (mailHoja === emailBuscado) {
                    const rawWallet = cols[2].trim().replace(/^"|"$/g, '');
                    if (ethers.isAddress(rawWallet)) {
                        walletFound = rawWallet;
                        // Columna G es índice 6
                        if (cols.length > 6) {
                            const rawIds = cols[6].trim().replace(/^"|"$/g, '');
                            if (rawIds) {
                                // Split flexible para "1,2", "1 2", "1;2"
                                idsPermitidos = rawIds.split(/[ ,;]+/).map(id => id.trim()).filter(id => /^\d+$/.test(id));
                            }
                        }
                    }
                    break;
                }
            }
        }

        if (!walletFound) return res.status(404).json({ error: "Usuario no encontrado." });

        const catalogo = await actualizarInsigniasDesdeSheet();
        const insigniasUsuario = {};

        if (idsPermitidos.length > 0) {
            for (const id of idsPermitidos) {
                if (catalogo[id]) {
                    insigniasUsuario[id] = { ...catalogo[id], owned: false };
                    const osUrl = `https://opensea.io/assets/polygon/${CONTRACT_ADDRESS}/${id}`;
                    insigniasUsuario[id].linkedin = buildLinkedInLink(catalogo[id].name, id, osUrl);

                    if (contract) {
                        try {
                            const balance = await contract.balanceOf(walletFound, id.toString());
                            if (BigInt(balance) > 0n) insigniasUsuario[id].owned = true;
                        } catch (err) {
                            console.warn(`Error verificando balance ID ${id}:`, err.message);
                        }
                    }
                }
            }
        }

        if (Object.keys(insigniasUsuario).length === 0) return res.status(404).json({ error: "No tienes insignias asignadas." });

        res.json({ success: true, wallet: walletFound, badges: insigniasUsuario });

    } catch (e) {
        console.error("Error consulta:", e);
        res.status(500).json({ error: "Error interno." });
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

        if (!badgeData) return res.status(404).json({ error: "Insignia no encontrada." });

        let balance = 0n;
        try { balance = await contract.balanceOf(userWallet, badgeId.toString()); } catch(e) {}

        if (BigInt(balance) > 0n) {
            const osUrl = `https://opensea.io/assets/polygon/${CONTRACT_ADDRESS}/${badgeId}`;
            return res.json({ 
                success: true, 
                alreadyOwned: true, 
                opensea: osUrl,
                linkedin: buildLinkedInLink(badgeData.name, badgeId, osUrl)
            });
        }

        const estimate = await contract.getFunction("mintInsignia(address,uint256,uint256)").estimateGas(userWallet, badgeId, 1);
        const gasLimit = (estimate * 130n) / 100n;
        
        const tx = await contract.getFunction("mintInsignia(address,uint256,uint256)")(userWallet, badgeId, 1, { gasLimit });
        
        const openSeaUrl = `https://opensea.io/assets/polygon/${CONTRACT_ADDRESS}/${badgeId}`;
        const linkedinUrl = buildLinkedInLink(badgeData.name, badgeId, openSeaUrl, tx.hash);

        res.json({
            success: true,
            alreadyOwned: false,
            txHash: tx.hash,
            opensea: openSeaUrl,
            linkedin: linkedinUrl,
            image: badgeData.image
        });

    } catch (error) {
        console.error("Fallo emisión:", error);
        res.status(500).json({ error: "Error Blockchain: " + (error.message || "Desconocido") });
    }
});

// === RUTA 3: METADATOS PARA OPENSEA ===
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
app.listen(PORT, () => console.log(`🚀 Servidor Enterprise v9.5 listo.`));
