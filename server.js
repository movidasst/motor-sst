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
const PROVIDER_URL = "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY; 

// ID de la pestaña "Insignias"
const GID_INSIGNIAS = "1450605916"; 
// ========================================================

const CONTRACT_ABI = ["function mintInsignia(address to, uint256 id, uint256 amount) public"];
const provider = new ethers.JsonRpcProvider(PROVIDER_URL);

let wallet;
let contract;

if (PRIVATE_KEY) {
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
    console.log(`🤖 Bot SST con Filtros Activo. Wallet: ${wallet.address}`);
}

// === CACHÉ DE INSIGNIAS (CATÁLOGO COMPLETO) ===
let insigniasCache = {};
let lastUpdate = 0;

async function actualizarInsigniasDesdeSheet() {
    // Si la caché es reciente (menos de 1 minuto), la usamos
    if (Date.now() - lastUpdate < 60000 && Object.keys(insigniasCache).length > 0) return insigniasCache;

    try {
        console.log("🔄 Leyendo catálogo de insignias...");
        const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_INSIGNIAS}`;
        const response = await axios.get(url);
        const filas = response.data.split('\n');
        
        const nuevasInsignias = {};

        for (let i = 1; i < filas.length; i++) {
            // Separa por comas respetando comillas
            const cols = filas[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (cols.length >= 4) {
                const id = cols[0]?.replace(/"/g, '').trim();
                // Validamos que haya un ID numérico
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
        console.error("Error leyendo insignias:", error.message);
        return insigniasCache;
    }
}

// === RUTA 1: VERIFICAR Y FILTRAR ===
app.post('/api/consultar-usuario', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Falta email" });

    // Hoja Principal (Usuarios) - GID 0 por defecto
    const urlUsers = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`; 
    
    try {
        const resp = await axios.get(urlUsers);
        const filas = resp.data.split('\n');
        
        let walletFound = null;
        let idsPermitidosString = ""; 
        const emailBuscado = email.trim().toLowerCase();

        for (let i = 1; i < filas.length; i++) {
            const cols = filas[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            
            // BUSCAMOS EN LAS COLUMNAS:
            // Col 1 (B): Email
            // Col 2 (C): Wallet
            // Col 6 (G): IDs ASIGNADOS

            if (cols.length >= 3) {
                const mailHoja = cols[1]?.replace(/"/g, '').trim().toLowerCase();
                
                if (mailHoja === emailBuscado) {
                    walletFound = cols[2]?.replace(/"/g, '').trim();
                    // Leemos la Columna G (índice 6) para ver qué permisos tiene
                    if (cols.length > 6) {
                        idsPermitidosString = cols[6]?.replace(/"/g, '').trim(); 
                    }
                    break;
                }
            }
        }

        if (!walletFound) return res.status(404).json({ error: "Usuario no encontrado en la base de datos." });

        // 2. Traer TODAS las insignias disponibles
        const catalogoCompleto = await actualizarInsigniasDesdeSheet();

        // 3. FILTRADO: Solo mostramos las que están en su columna G
        const insigniasDelUsuario = {};

        // Si la celda está vacía, no mostramos nada (seguridad)
        if (idsPermitidosString) {
             // Convertimos "1, 2, 3" en array ["1", "2", "3"]
            const listaIDs = idsPermitidosString.split(',').map(id => id.trim());

            // Solo agregamos las que coinciden
            listaIDs.forEach(id => {
                if (catalogoCompleto[id]) {
                    insigniasDelUsuario[id] = catalogoCompleto[id];
                }
            });
        }

        if (Object.keys(insigniasDelUsuario).length === 0) {
            return res.status(404).json({ error: "Usuario encontrado, pero no tiene insignias asignadas en la Columna G." });
        }

        res.json({
            success: true,
            wallet: walletFound,
            badges: insigniasDelUsuario // SOLO enviamos las filtradas
        });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Error consultando datos" });
    }
});

// === RUTA 2: EMITIR ===
app.post('/api/emitir-insignia', async (req, res) => {
    const { wallet, badgeId } = req.body;
    if (!wallet || !badgeId) return res.status(400).json({ error: "Datos incompletos" });

    try {
        const insignias = await actualizarInsigniasDesdeSheet();
        const badgeData = insignias[badgeId];

        if (!badgeData) return res.status(404).json({ error: "Insignia no existente" });

        console.log(`Emitiendo ID ${badgeId} a ${wallet}`);
        
        const tx = await contract.mintInsignia(wallet, badgeId, 1);
        await tx.wait();

        const openSeaUrl = `https://opensea.io/assets/matic/${CONTRACT_ADDRESS}/${badgeId}`;
        const linkedinUrl = `https://www.linkedin.com/profile/add?startTask=CERTIFICATION_NAME&name=${encodeURIComponent(badgeData.name)}&organizationName=La%20Movida%20de%20SST%20DAO&issueYear=${new Date().getFullYear()}&certUrl=${encodeURIComponent(openSeaUrl)}&certId=${tx.hash}`;

        res.json({
            success: true,
            txHash: tx.hash,
            opensea: openSeaUrl,
            linkedin: linkedinUrl,
            image: badgeData.image
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error en blockchain" });
    }
});

// === METADATA PARA OPENSEA ===
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
app.listen(PORT, () => console.log(`🚀 Servidor Filtrado listo en puerto ${PORT}`));
