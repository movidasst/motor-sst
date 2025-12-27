require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

// ================= DATOS DE TU PROYECTO =================
const CONTRACT_ADDRESS = "0x4A5340cBB1e2D000357880fFBaC8AA5B6Cf557fD"; 
const SHEET_ID = "15Xg4nlQIK6FCFrCAli8qgKvWtwtDzXjBmVFHwYgF2TI"; 

// Usamos ANKR: Es el RPC público más rápido y estable actualmente
const PROVIDER_URL = "https://rpc.ankr.com/polygon"; 
const PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY; 

// IDs de las pestañas (GIDs) correctos
const GID_INSIGNIAS = "1450605916"; 
const GID_USUARIOS = "351737717";   
// ========================================================

// ✅ ABI CORREGIDO: Solo una definición de mint para evitar ambigüedad
const CONTRACT_ABI = [
    "function mintInsignia(address to, uint256 id, uint256 amount) public",
    "function balanceOf(address account, uint256 id) public view returns (uint256)"
];

const provider = new ethers.JsonRpcProvider(PROVIDER_URL);

let wallet;
let contract;

if (PRIVATE_KEY) {
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
    console.log(`🤖 Bot SST Activo y Rápido. Wallet: ${wallet.address}`);
} else {
    console.log("⚠️ ERROR: Falta ADMIN_PRIVATE_KEY en Render.");
}

// === CACHÉ DE INSIGNIAS ===
let insigniasCache = {};
let lastUpdate = 0;

async function actualizarInsigniasDesdeSheet() {
    // Si la caché es reciente (menos de 2 min), la usamos para no esperar a Google
    if (Date.now() - lastUpdate < 120000 && Object.keys(insigniasCache).length > 0) return insigniasCache;
    try {
        console.log("🔄 Leyendo insignias...");
        const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_INSIGNIAS}`;
        const response = await axios.get(url);
        const filas = response.data.split('\n');
        const nuevasInsignias = {};

        for (let i = 1; i < filas.length; i++) {
            // Separa por comas inteligente
            const cols = filas[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (cols.length >= 4) {
                const id = cols[0]?.replace(/"/g, '').trim();
                // Validamos que sea un ID numérico
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
    } catch (error) { 
        console.error("Error leyendo insignias, usando caché vieja:", error.message);
        return insigniasCache; 
    }
}

// RUTA PRINCIPAL (Para comprobar que está vivo)
app.get('/', (req, res) => {
    res.send("✅ Servidor SST DAO Funcionando Correctamente.");
});

// === RUTA 1: CONSULTAR USUARIO (CON LÓGICA DE FILTROS) ===
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
            
            // TU ESTRUCTURA: Col B (Email), Col C (Wallet), Col G (IDs)
            if (cols.length >= 3) {
                const mailHoja = cols[1]?.replace(/"/g, '').trim().toLowerCase();
                
                if (mailHoja === emailBuscado) {
                    walletFound = cols[2]?.replace(/"/g, '').trim();
                    // Leemos Columna G (índice 6) para los permisos
                    if (cols.length > 6) {
                        idsPermitidosString = cols[6]?.replace(/"/g, '').trim(); 
                    }
                    break;
                }
            }
        }

        if (!walletFound) return res.status(404).json({ error: "Usuario no encontrado en la hoja de respuestas." });

        const catalogo = await actualizarInsigniasDesdeSheet();
        const insigniasUsuario = {};

        // Filtramos: Solo agregamos las que están en la columna G
        if (idsPermitidosString) {
            const listaIDs = idsPermitidosString.split(',').map(id => id.trim());
            
            // Verificamos propiedad en Blockchain para pintar el botón azul si ya la tiene
            await Promise.all(listaIDs.map(async (id) => {
                if (catalogo[id]) {
                    insigniasUsuario[id] = { ...catalogo[id], owned: false }; 

                    if (contract) {
                        try {
                            const idBN = BigInt(id); // Conversión segura
                            const balance = await contract.balanceOf(walletFound, idBN);
                            if (balance > 0n) insigniasUsuario[id].owned = true;
                        } catch (err) {
                            console.error(`Error verificando balance ID ${id}:`, err.message);
                        }
                    }
                }
            }));
        }

        if (Object.keys(insigniasUsuario).length === 0) {
            return res.status(404).json({ error: "Usuario encontrado, pero no tiene insignias asignadas en la Columna G." });
        }

        res.json({ success: true, wallet: walletFound, badges: insigniasUsuario });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Error de servidor al leer Excel." });
    }
});

// === RUTA 2: EMITIR (PROTEGIDA Y RÁPIDA) ===
app.post('/api/emitir-insignia', async (req, res) => {
    const { wallet: userWallet, badgeId } = req.body;
    
    if (!userWallet || !badgeId) return res.status(400).json({ error: "Datos incompletos" });
    if (!contract || !wallet) return res.status(500).json({ error: "Error interno: Falta wallet admin." });

    try {
        const idBN = BigInt(badgeId); // Conversión segura a BigInt
        const catalogo = await actualizarInsigniasDesdeSheet();
        const badgeData = catalogo[badgeId];
        
        if (!badgeData) return res.status(404).json({ error: "Insignia no existente." });

        // Verificamos si ya la tiene para no gastar gas
        let balance = 0n;
        try {
            balance = await contract.balanceOf(userWallet, idBN);
        } catch(e) { console.log("Saltando check balance..."); }

        let txHash = "YA_EXISTE"; 

        if (balance > 0n) {
            console.log(`El usuario ${userWallet} ya tiene la insignia ${badgeId}.`);
        } else {
            console.log(`🚀 Emitiendo ID ${badgeId} a ${userWallet}...`);
            
            // MODO TURBO: "Fire and Forget"
            // No esperamos el wait() para que la respuesta sea instantánea
            const tx = await contract.mintInsignia(userWallet, idBN, 1, { gasLimit: 500000 });
            txHash = tx.hash;
            console.log(`✅ Tx Enviada: ${txHash}`);
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
        let msg = "Error desconocido.";
        if (error.code === 'INSUFFICIENT_FUNDS') msg = "La DAO no tiene fondos (MATIC).";
        else if (error.message) msg = error.message;
        
        res.status(500).json({ error: "Fallo Blockchain: " + msg });
    }
});

app.get('/api/metadata/:id.json', async (req, res) => {
    const id = req.params.id;
    const insignias = await actualizarInsigniasDesdeSheet();
    const badge = insignias[id];
    if (!badge) return res.status(404).json({ error: "No encontrada" });
    res.json({
        name: badge.name, description: badge.description, image: badge.image,
        attributes: [{ trait_type: "Emisor", value: "SST DAO" }]
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor Rápido listo en puerto ${PORT}`));
