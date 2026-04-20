export interface TicketAnalysis {
    problema_raiz: string;
    solucion_sugerida: string;
    prioridad: 1 | 2 | 3 | 4 | 5;
    tecnologia_afectada: string;
}

export type CategoriaLocal = "URGENTE" | "CONSULTA" | "SPAM";