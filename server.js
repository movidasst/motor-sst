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

const PROVIDER_URL = "https://polygon-rpc.com"; 
const PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY; 
// ======================================================

// 1️⃣ ABI ESTRICTO: Definimos solo lo necesario y usamos nombres claros
const CONTRACT_ABI = [
    // Firma explícita de 3 argumentos (la que usa tu contrato actual)
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
    if (Date.now() - lastUpdate < 120000 && Object.keys(insigniasCache).length > 0) return insigniasCache;
    try {
        console.log("📥 Sincronizando Google Sheets...");
        const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_INSIGNIAS}`;
        const response = await axios.get(url, { timeout: 8000 });
        
        const filas = response.data.split('\n');
        const nuevasInsignias = {};

        for (let i = 1; i < filas.length; i++) {
            // Parser CSV manual robusto para este caso simple
            const cols = filas[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (cols.length >= 4) {
                const idRaw = cols[0]?.replace(/"/g, '').trim();
                // 7️⃣ Validación estricta de ID
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
        }
        return insigniasCache;
    } catch (error) { 
        console.error("⚠️ Falló actualización Sheet:", error.message);
        return insigniasCache; 
    }
}

app.get('/', (req, res) => res.send("✅ Servidor SST DAO Activo (v7.0 Enterprise)."));

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
                    // 5️⃣ Validación estricta de Wallet
                    if (ethers.isAddress(rawWallet)) {
                        walletFound = rawWallet;
                        if (cols.length > 6) {
                            const rawIds = cols[6]?.replace(/"/g, '').trim();
                            if (rawIds) idsPermitidos = rawIds.split(',').map(id => id.trim()).filter(id => /^\d+$/.test(id));
                        }
                    }
                    break;
                }
            }
        }

        if (!walletFound) return res.status(404).json({ error: "Usuario no encontrado o wallet inválida." });

        const catalogo = await actualizarInsigniasDesdeSheet();
        const insigniasUsuario = {};

        // 5️⃣ SOLUCIÓN RATE LIMIT: Loop secuencial en vez de Promise.all masivo
        // Esto protege al RPC público de bloqueos
        if (idsPermitidos.length > 0) {
            for (const id of idsPermitidos) {
                if (catalogo[id]) {
                    insigniasUsuario[id] = { ...catalogo[id], owned: false };
                    if (contract) {
                        try {
                            const idBN = BigInt(id);
                            // Llamada segura
                            const balance = await contract.balanceOf(walletFound, idBN);
                            if (balance > 0n) insigniasUsuario[id].owned = true;
                        } catch (err) {
                            console.warn(`Skipping balance check for ID ${id} due to RPC error.`);
                        }
                    }
                }
            }
        }

        if (Object.keys(insigniasUsuario).length === 0) return res.status(404).json({ error: "Usuario sin insignias asignadas." });

        res.json({ success: true, wallet: walletFound, badges: insigniasUsuario });

    } catch (e) {
        console.error("Error consulta:", e);
        res.status(500).json({ error: "Error interno." });
    }
});

// === RUTA 2: EMITIR (BLINDADA) ===
app.post('/api/emitir-insignia', async (req, res) => {
    const { wallet: userWallet, badgeId } = req.body;

    // 5️⃣ Validaciones Previas
    if (!userWallet || !ethers.isAddress(userWallet)) return res.status(400).json({ error: "Wallet inválida." });
    if (!badgeId) return res.status(400).json({ error: "Falta ID." });

    try {
        const idBN = BigInt(badgeId);
        const catalogo = await actualizarInsigniasDesdeSheet();
        const badgeData = catalogo[badgeId];

        if (!badgeData) return res.status(404).json({ error: "Insignia no existe." });

        console.log(`🤖 Iniciando proceso ID ${idBN} -> ${userWallet}`);

        // Verificación de balance (Idempotencia)
        let balance = 0n;
        try {
            balance = await contract.balanceOf(userWallet, idBN);
        } catch(e) { console.log("Balance check skipped..."); }

        if (balance > 0n) {
            console.log("ℹ️ Ya posee la insignia.");
            // 2️⃣ URL OPENSEA CORRECTA (Polygon)
            const osUrl = `https://opensea.io/assets/polygon/${CONTRACT_ADDRESS}/${badgeId}`;
            return res.json({ success: true, alreadyOwned: true, opensea: osUrl });
        }

        // 6️⃣ GAS DINÁMICO (Adiós ruleta rusa)
        let gasLimit;
        let tx;
        
        try {
            // Intentamos estimar el gas real. Si el contrato va a fallar, esto lanza error aquí.
            // 1️⃣ LLAMADA EXPLÍCITA POR FIRMA para evitar ambigüedad
            const estimate = await contract.getFunction("mintInsignia(address,uint256,uint256)").estimateGas(userWallet, idBN, 1);
            // Agregamos 20% de colchón
            gasLimit = (estimate * 120n) / 100n;
            
            console.log(`⛽ Gas estimado: ${estimate.toString()} (+20% buffer)`);
            
            // Ejecución
            tx = await contract.getFunction("mintInsignia(address,uint256,uint256)")(
                userWallet, 
                idBN, 
                1, 
                { gasLimit }
            );
            
        } catch (err) {
            console.error("❌ Falló estimación/emisión:", err.message);
            // Si es un error de reversión del contrato, lo mostramos
            if (err.code === 'CALL_EXCEPTION') {
                return res.status(400).json({ error: "El contrato rechazó la operación (posiblemente ID inválido o permisos)." });
            }
            throw err; // Relanzamos otros errores
        }

        console.log(`✅ Tx Hash: ${tx.hash}`);

        // 2️⃣ URLs ACTUALIZADAS
        const openSeaUrl = `https://opensea.io/assets/polygon/${CONTRACT_ADDRESS}/${badgeId}`;
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
        if (error.code === 'INSUFFICIENT_FUNDS') msg = "Falta MATIC en la DAO.";
        else if (error.message) msg = error.message;
        
        res.status(500).json({ error: "Blockchain Error: " + msg });
    }
});

// 8️⃣ Metadata Cache Headers
app.get('/api/metadata/:id.json', async (req, res) => {
    let id = req.params.id;
    if (id.length > 10) { try { id = BigInt(id).toString(); } catch(e) {} }

    const catalogo = await actualizarInsigniasDesdeSheet();
    const badge = catalogo[id];
    
    if (!badge) return res.status(404).json({ error: "Not found" });
    
    // Header para que OpenSea cachee esto y no tumbe tu servidor
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache de 24h
    
    res.json({
        name: badge.name, 
        description: badge.description, 
        image: badge.image,
        external_url: "https://movidasst.com" // O tu URL principal
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor Enterprise listo en puerto ${PORT}`));
