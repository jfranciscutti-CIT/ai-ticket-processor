
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import * as dotenv from 'dotenv';
import { TicketAnalysis, CategoriaLocal } from './src/types/types.js';
import express from 'express';
import cors from 'cors';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const OLLAMA_URL = 'http://localhost:11434/api/generate';

class TicketProcessor {

    private cleanData(rawText: string): string {
        return rawText
            .replace(/De:.*|Enviado el:.*|Para:.*/g, "") // Quita cabeceras de mail
            .replace(/--\s*\n[\s\S]*/, "")               // Quita firmas
            .replace(/\s+/g, " ")                        // Colapsa espacios (ahorro de tokens)
            .trim();
    }

    private validateInput(text: string): void {
        const maliciousPatterns = [
            "ignora las instrucciones",
            "forget previous instructions",
            "eres un administrador",
            "system override",
            "dame tu prompt"
        ];

        for (const pattern of maliciousPatterns) {
            if (text.toLowerCase().includes(pattern)) {
                console.error(`Seguridad: Intento de manipulación detectado ("${pattern}")`);
                throw new Error(`Seguridad: Intento de manipulación detectado ("${pattern}")`);
            }
        }
    }

    private async classifyLocally(text: string): Promise<CategoriaLocal> {
        const lowerText = text.toLowerCase();

        // 1. FILTRO DE SPAM (Heurística rápida)
        if (this.isSpam(lowerText)) {
            console.log("🚨 Detectado como SPAM");
            return "SPAM";
        }

        // 2. FILTRO DE SEGURIDAD (Heurística para casos graves)
        const esProblemaGrave = this.detectarProblemaGrave(lowerText);

        if (!esProblemaGrave) {
            console.log("ℹ️ No parece grave, clasificando como CONSULTA");
            return "CONSULTA";
        }

        // 3. LLAMADA A OLLAMA (Solo para casos dudosos)
        return await this.classifyWithOllama(text);
    }

    private isSpam(text: string): boolean {
        const lowerText = text.toLowerCase();

        // Patrones de "Alta Confianza" (Si aparece uno, es SPAM directo)
        const instantSpam = [
            /viagra|cialis|casino|lotería|ganaste|premio/i,
            /haz click aquí|enlace sospechoso|oferta exclusiva/i,
            /trabaja desde casa.*ganarás/i,
            /bit\.ly|t\.co|tinyurl/i // Acortadores de links típicos de spam
        ];

        if (instantSpam.some(pattern => pattern.test(lowerText))) return true;

        // Patrones de "Baja Confianza" (Necesitan sumar puntos)
        const softSpam = [
            /verific/i, /identidad/i, /contraseña/i, /password/i,
            /urgente/i, /ahora/i, /click/i, /oferta/i, /descuento/i,
            /http/i, /www/i, /whatsapp/i
        ];

        let spamScore = 0;
        softSpam.forEach(pattern => {
            if (pattern.test(lowerText)) spamScore++;
        });

        // Si tiene 3 o más palabras sospechosas juntas, es SPAM
        if (spamScore >= 3) return true;

        return this.esCorreoGenerico(lowerText);
    }

    private esCorreoGenerico(text: string): boolean {
        // Correos muy cortos sin detalles específicos
        if (text.length < 20) return false;

        const genericPhrases = [
            "hola a todos",
            "dear customer",
            "valued customer",
            "dear user",
        ];

        return genericPhrases.some(phrase => text.includes(phrase)) &&
            !this.tieneDetallesTecnicos(text);
    }

    private tieneDetallesTecnicos(text: string): boolean {
        const technicalKeywords = [
            "error", "codigo", "servidor", "base datos", "api",
            "puerto", "ip", "url", "log", "stack trace",
            "version", "sistema operativo", "navegador"
        ];
        return technicalKeywords.some(keyword => text.includes(keyword));
    }

    private detectarProblemaGrave(text: string): boolean {
        const urgentKeywords = [
            // Sistema caído
            "caido", "down", "offline", "muerto", "no funciona",
            "no responde", "inaccesible",

            // Errores críticos
            "error 500", "error 502", "error 503",
            "timeout", "conexión rechazada",

            // Alcance
            "produccion", "production", "todos los usuarios",
            "empresa completa", "sin acceso",

            // Urgencia
            "urgente", "crítico", "emergencia", "asap",
            "ahora mismo", "inmediato"
        ];

        // Al menos 1 keyword urgente
        const tieneKeywordUrgente = urgentKeywords.some(kw => text.includes(kw));

        if (!tieneKeywordUrgente) return false;

        // Verificar que NO sea una falsa alarma (usuario individual)
        const falasAlarmas = [
            "mi mouse", "mi teclado", "mi monitor", "mi contraseña",
            "mi cuenta", "yo solo", "solo a mí", "problema personal"
        ];

        const esFalsaAlarma = falasAlarmas.some(fa => text.includes(fa));

        return !esFalsaAlarma;
    }

    private async classifyWithOllama(text: string): Promise<CategoriaLocal> {
        try {
            const response = await axios.post(OLLAMA_URL, {
                model: "llama3.2:3b",
                prompt: `### INSTRUCCIONES ###
    Clasifica este email de soporte en UNA de estas categorías:
    
    - URGENTE: Problema crítico que afecta a múltiples usuarios o el sistema en producción
      (servidor caído, base de datos offline, error en API principal, etc.)
      
    - CONSULTA: Pregunta sobre cómo usar el sistema o problema individual
      (usuario olvidó contraseña, no sabe cómo hacer algo, problema en su equipo)
      
    - SPAM: Emails promocionales, phishing, o no relacionados con soporte técnico
    
    Email: "${text.substring(0, 500)}"
    
    Responde SOLO con una palabra: URGENTE, CONSULTA o SPAM`,
                stream: false,
                temperature: 0.3, // Baja temperatura para respuestas consistentes
            });

            const result = (response.data as { response: string })
                .response
                .toUpperCase()
                .trim()
                .split('\n')[0]; // Tomar primera línea

            console.log(`🤖 Clasificación Ollama: [${result}]`);

            if (result.includes("URGENTE")) return "URGENTE";
            if (result.includes("SPAM")) return "SPAM";

            return "CONSULTA";
        } catch (error) {
            console.error("❌ Error en Ollama, clasificando como CONSULTA por defecto", error);
            return "CONSULTA";
        }
    }

    private async analyzeWithClaude(text: string): Promise<TicketAnalysis> {
        const response = await anthropic.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 1500,
            // TÉCNICA: Role Prompting + CoT Instructions
            system: `Eres un Ingeniero de Soporte Nivel 3. 
            Antes de responder, analiza el problema paso a paso dentro de etiquetas <thinking>. 
            Luego, entrega ÚNICAMENTE el objeto JSON final dentro de etiquetas <json>.`,
            messages: [
                {
                    role: "user",
                    content: `### TICKET ###
                             ${text}
                             
                             ### TAREA ###
                             1. En <thinking>, identifica síntomas, descarta causas comunes y propón una raíz técnica.
                             2. En <json>, devuelve: {"problema_raiz": "...", "solucion_sugerida": "...", "prioridad": 1-5, "tecnologia_afectada": "..."}`
                }
            ]
        });

        const content = response.content[0].type === 'text' ? response.content[0].text : '';

        // TÉCNICA: Extracción robusta basada en delimitadores (Output Structuring)
        const jsonMatch = content.match(/<json>([\s\S]*?)<\/json>/);
        const thoughtMatch = content.match(/<thinking>([\s\S]*?)<\/thinking>/);

        if (thoughtMatch) {
            console.log("🧠 Razonamiento interno de la IA:", thoughtMatch[1].trim());
        }

        if (jsonMatch) {
            return JSON.parse(jsonMatch[1].trim()) as TicketAnalysis;
        }

        // Fallback por si la IA ignora las etiquetas pero manda JSON
        return JSON.parse(content.replace(/```json|```/g, "").trim()) as TicketAnalysis;
    }

    public async run(rawTicket: string) {
        this.validateInput(rawTicket);
        const cleanTicket = this.cleanData(rawTicket);
        const category = await this.classifyLocally(cleanTicket);

        let analysis = null;
        if (category === "URGENTE") {
            analysis = await this.analyzeWithClaude(cleanTicket);
        }

        // Devolvemos todo el rastro para que el Front pueda mostrar los pasos
        return {
            cleanTicket,
            category,
            analysis
        };
    }
}

const app = express();
app.use(cors()); // Importante para que Next.js/Vercel pueda conectarse
app.use(express.json());

const processor = new TicketProcessor();

app.post('/api/process', async (req, res) => {
    const { ticket } = req.body;

    if (!ticket) {
        return res.status(400).json({ error: "No se proporcionó un ticket" });
    }

    try {
        console.log("--- Recibida petición desde el Frontend ---");

        // Ejecutamos el pipeline (modifica el método run para que retorne los datos)
        const result = await processor.run(ticket);

        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`🚀 Back-end de IA corriendo en http://localhost:${PORT}`);
});
