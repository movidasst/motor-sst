require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

// ================= DATOS DEL PROYECTO =================
const CONTRACT_ADDRESS = "0x4A5340cBB1e2D000357880fFBaC8AA5B6Cf557fD"; 
const SHEET_ID = "15Xg4nlQIK6FCFrCAli8qgKvWtwtDzXjBmVFHwYgF2TI"; 
// GIDs
const GID_INSIGNIAS = "1450605916"; 
const GID_USUARIOS = "351737717";   

// Usamos ANKR (Estable y Rápido)
const PROVIDER_URL = "https://rpc.ankr.com/polygon"; 
const PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY; 
// ======================================================

// ABI Corregido y Robusto
const CONTRACT_ABI = [
    // La firma que definimos en Solidity (3 argumentos)
    "function mintInsignia(address to, uint256 id, uint256 amount) public",
    // Firma estándar (4 argumentos) por si el contrato cambió
    "function mintInsignia(address to, uint256 id, uint256 amount, bytes data) public",
    // Lectura
    "function balanceOf(address account, uint256 id) public view returns (uint256)"
];

// Validación de Entorno
if (!PRIVATE_KEY) {
    console.error("🚨 ERROR CRÍTICO: Falta ADMIN_PRIVATE_KEY. El servidor no podrá firmar.");
    process.exit(1); // Detener ejecución si no es seguro
}

const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

console.log(`🛡️ SISTEMA SECURE-MINT INICIADO.`);
console.log(`🔑 Wallet Admin: ${wallet.address}`);

// === CACHÉ RESILIENTE ===
let insigniasCache = {};
let lastUpdate = 0;

async function actualizarInsigniasDesdeSheet() {
    // Si la caché es fresca (2 min), úsala.
    if (Date.now() - lastUpdate < 120000 && Object.keys(insigniasCache).length > 0) {
        return insigniasCache;
    }
    
    try {
        console.log("📥 Sincronizando con Google Sheets...");
        const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_INSIGNIAS}`;
        const response = await axios.get(url, { timeout: 5000 }); // Timeout de 5s para no colgarse
        
        const filas = response.data.split('\n');
        const nuevasInsignias = {};

        for (let i = 1; i < filas.length; i++) {
            // Regex seguro para CSV con comillas
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
        
        // Solo actualizamos si obtuvimos datos válidos
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

// === RUTA 1: CONSULTAR USUARIO (Validada) ===
app.post('/api/consultar-usuario', async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: "Email inválido" });

    try {
        // Obtenemos CSV de usuarios
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
                    
                    // VALIDACIÓN DE WALLET ESTRICTA
                    if (ethers.isAddress(rawWallet)) {
                        walletFound = rawWallet;
                        
                        // Parsear IDs permitidos (Columna G - index 6)
                        if (cols.length > 6) {
                            const rawIds = cols[6]?.replace(/"/g, '').trim();
                            if (rawIds) {
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
                        // BigInt seguro
                        const balance = await contract.balanceOf(walletFound, BigInt(id));
                        if (balance > 0n) insigniasUsuario[id].owned = true;
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

// === RUTA 2: EMITIR (Idempotente y Segura) ===
app.post('/api/emitir-insignia', async (req, res) => {
    const { wallet: userWallet, badgeId } = req.body;

    // 1. Validaciones estrictas de entrada
    if (!userWallet || !ethers.isAddress(userWallet)) {
        return res.status(400).json({ error: "Wallet inválida." });
    }
    if (!badgeId) {
        return res.status(400).json({ error: "Falta Badge ID." });
    }

    try {
        const idBN = BigInt(badgeId); // Conversión segura a BigInt
        const catalogo = await actualizarInsigniasDesdeSheet();
        const badgeData = catalogo[badgeId];

        if (!badgeData) return res.status(404).json({ error: "Insignia no existe en el catálogo." });

        console.log(`🤖 Procesando: ID ${idBN} -> ${userWallet}`);

        // 2. IDEMPOTENCIA: Verificar si ya lo tiene (Lectura obligatoria)
        const balance = await contract.balanceOf(userWallet, idBN);
        
        if (balance > 0n) {
            console.log(`ℹ️ Omitiendo mint: El usuario ya posee la insignia.`);
            // Devolvemos éxito pero con flag 'alreadyOwned'
            return res.json({
                success: true,
                alreadyOwned: true,
                opensea: `https://opensea.io/assets/matic/${CONTRACT_ADDRESS}/${badgeId}`,
                linkedin: null // No generamos link de LinkedIn si no hay TX nueva
            });
        }

        // 3. ESTIMACIÓN DE GAS (Para evitar quemar dinero)
        let gasLimit;
        try {
            // Intentamos estimar. Si el contrato va a fallar (revert), esto lanza error aquí.
            const estimated = await contract.mintInsignia.estimateGas(userWallet, idBN, 1);
            // Agregamos un colchón del 20% por seguridad
            gasLimit = (estimated * 120n) / 100n;
        } catch (err) {
            console.error("❌ Falló estimación de gas:", err.message);
            // Fallback manual seguro si la estimación falla pero queremos intentar
            gasLimit = 150000n; 
        }

        // 4. EJECUCIÓN (Fire & Forget pero segura)
        const tx = await contract.mintInsignia(userWallet, idBN, 1, { gasLimit });
        console.log(`✅ Tx Enviada: ${tx.hash}`);

        // Preparamos respuesta inmediata
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
        
        let msg = "Error desconocido procesando la transacción.";
        if (error.code === 'INSUFFICIENT_FUNDS') msg = "La DAO no tiene fondos suficientes (MATIC) para pagar el gas.";
        if (error.code === 'NONCE_EXPIRED') msg = "La red está congestionada, intenta en 1 minuto.";
        
        res.status(500).json({ error: msg });
    }
});

// Metadata endpoint
app.get('/api/metadata/:id.json', async (req, res) => {
    const id = req.params.id;
    const catalogo = await actualizarInsigniasDesdeSheet();
    const badge = catalogo[id];
    if (!badge) return res.status(404).json({ error: "Not found" });
    res.json({ name: badge.name, description: badge.description, image: badge.image });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor Senior v4.0 listo en ${PORT}`));
