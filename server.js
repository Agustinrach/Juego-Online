const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ==========================================
// CONFIGURACIÓN DEL JUEGO
// ==========================================

const ANCHO_MAPA = 5000;
const ALTO_MAPA = 600;

const META_X = 4850;

const MAX_JUGADORES = 4;
const MAX_ALIADOS = 3;
const MAX_ENEMIGOS = 1;

const VELOCIDAD_ALIADO = 5;
const VELOCIDAD_ENEMIGO = 3.5;

const DURACION_RALENTIZADO = 4000;
const MULTIPLICADOR_RALENTIZADO = 0.45;

const COOLDOWN_TRAMPA = 5000;

const RADIO_TRAMPA = 32;

const INTERVALO_ESTADO = 50; // 20 actualizaciones por segundo

// ==========================================
// SERVIR ARCHIVOS
// ==========================================

app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/index.html");
});

// ==========================================
// SALAS
// ==========================================

const salas = {};

// ==========================================
// UTILIDADES
// ==========================================

function generarCodigoSala() {
    let codigo;

    do {
        codigo = Math.random()
            .toString(36)
            .substring(2, 6)
            .toUpperCase();
    } while (salas[codigo]);

    return codigo;
}

function contarRoles(sala) {
    let aliados = 0;
    let enemigos = 0;

    for (const id in sala.jugadores) {
        const jugador = sala.jugadores[id];

        if (jugador.rol === "aliado") {
            aliados++;
        }

        if (jugador.rol === "enemigo") {
            enemigos++;
        }
    }

    return {
        aliados,
        enemigos
    };
}

function posicionesIniciales(sala) {

    const { aliados, enemigos } = contarRoles(sala);

    const separacion = 80;

    return {
        aliado: {
            x: 150,
            y: 180 + aliados * separacion
        },

        enemigo: {
            x: 4400,
            y: 300 + enemigos * separacion
        }
    };
}

function crearJugador(socketId, nombre) {

    return {
        id: socketId,

        nombre: nombre || "Jugador",

        rol: null,

        x: 0,
        y: 0,

        objetivoX: 0,
        objetivoY: 0,

        muerto: false,

        ralentizadoHasta: 0,

        ultimaActualizacion: Date.now(),

        ultimaTrampa: 0
    };
}

function obtenerVelocidad(jugador) {

    let velocidad =
        jugador.rol === "enemigo"
            ? VELOCIDAD_ENEMIGO
            : VELOCIDAD_ALIADO;

    if (Date.now() < jugador.ralentizadoHasta) {
        velocidad *= MULTIPLICADOR_RALENTIZADO;
    }

    return velocidad;
}

function limitarNumero(valor, minimo, maximo) {
    return Math.max(minimo, Math.min(maximo, valor));
}

function distancia(x1, y1, x2, y2) {

    const dx = x1 - x2;
    const dy = y1 - y2;

    return Math.sqrt(dx * dx + dy * dy);
}

// ==========================================
// ESTADO QUE SE ENVÍA A LOS CLIENTES
// ==========================================

function obtenerEstadoSala(sala) {

    const jugadores = {};

    for (const id in sala.jugadores) {

        const jugador = sala.jugadores[id];

        jugadores[id] = {
            id: jugador.id,
            nombre: jugador.nombre,
            rol: jugador.rol,

            x: jugador.x,
            y: jugador.y,

            muerto: jugador.muerto,

            ralentizadoHasta: jugador.ralentizadoHasta
        };
    }

    return {
        jugadores,
        trampas: sala.trampas,

        anchoMapa: ANCHO_MAPA,
        altoMapa: ALTO_MAPA,
        metaX: META_X,

        iniciada: sala.iniciada,
        terminada: sala.terminada
    };
}

function enviarEstado(sala) {

    if (!sala) return;

    io.to(sala.codigo).emit(
        "actualizarMapa",
        obtenerEstadoSala(sala)
    );
}

// ==========================================
// ACTUALIZAR ROLES
// ==========================================

function actualizarRoles(sala) {

    const jugadores = {};

    for (const id in sala.jugadores) {

        const jugador = sala.jugadores[id];

        jugadores[id] = {
            id: jugador.id,
            nombre: jugador.nombre,
            rol: jugador.rol
        };
    }

    io.to(sala.codigo).emit(
        "actualizarRoles",
        jugadores
    );
}

// ==========================================
// POSICIONES INICIALES
// ==========================================

function colocarJugadorInicial(jugador, sala) {

    const posiciones = posicionesIniciales(sala);

    if (jugador.rol === "aliado") {

        jugador.x = posiciones.aliado.x;
        jugador.y = posiciones.aliado.y;

    } else if (jugador.rol === "enemigo") {

        jugador.x = posiciones.enemigo.x;
        jugador.y = posiciones.enemigo.y;
    }

    jugador.objetivoX = jugador.x;
    jugador.objetivoY = jugador.y;
}

// ==========================================
// COMPROBAR SI PUEDE COMENZAR
// ==========================================

function intentarComenzarPartida(sala) {

    if (sala.iniciada || sala.terminada) {
        return;
    }

    const ids = Object.keys(sala.jugadores);

    if (ids.length !== MAX_JUGADORES) {
        return;
    }

    const { aliados, enemigos } = contarRoles(sala);

    if (
        aliados !== MAX_ALIADOS ||
        enemigos !== MAX_ENEMIGOS
    ) {
        return;
    }

    // Posicionar jugadores
    for (const id of ids) {

        const jugador = sala.jugadores[id];

        jugador.muerto = false;
        jugador.ralentizadoHasta = 0;
        jugador.ultimaTrampa = 0;

        colocarJugadorInicial(jugador, sala);
    }

    sala.iniciada = true;
    sala.terminada = false;

    sala.trampas = [];

    io.to(sala.codigo).emit(
        "partidaIniciada",
        obtenerEstadoSala(sala)
    );

    enviarEstado(sala);
}

// ==========================================
// COMPROBAR VICTORIA
// ==========================================

function comprobarVictoria(sala) {

    if (!sala.iniciada || sala.terminada) {
        return;
    }

    let aliadosVivos = 0;
    let enemigoVivo = false;

    for (const id in sala.jugadores) {

        const jugador = sala.jugadores[id];

        if (jugador.rol === "aliado") {

            if (!jugador.muerto) {
                aliadosVivos++;
            }
        }

        if (jugador.rol === "enemigo") {

            if (!jugador.muerto) {
                enemigoVivo = true;
            }
        }
    }

    // ------------------------------------------
    // GANAN LOS ALIADOS
    // ------------------------------------------

    if (aliadosVivos > 0) {

        for (const id in sala.jugadores) {

            const jugador = sala.jugadores[id];

            if (
                jugador.rol === "aliado" &&
                !jugador.muerto &&
                jugador.x >= META_X
            ) {

                sala.terminada = true;

                io.to(sala.codigo).emit(
                    "aliadosGanan",
                    {
                        jugadorGanador: jugador.id
                    }
                );

                enviarEstado(sala);

                return;
            }
        }
    }

    // ------------------------------------------
    // GANA EL ENEMIGO
    // ------------------------------------------

    if (aliadosVivos === 0 && enemigoVivo) {

        sala.terminada = true;

        io.to(sala.codigo).emit(
            "enemigoGana"
        );

        enviarEstado(sala);

        return;
    }
}

// ==========================================
// TRAMPAS
// ==========================================

function colocarTrampa(sala, jugador, x, y) {

    if (!sala.iniciada || sala.terminada) {
        return;
    }

    if (jugador.rol !== "enemigo") {
        return;
    }

    if (jugador.muerto) {
        return;
    }

    const ahora = Date.now();

    if (
        ahora - jugador.ultimaTrampa <
        COOLDOWN_TRAMPA
    ) {

        const restante =
            COOLDOWN_TRAMPA -
            (ahora - jugador.ultimaTrampa);

        io.to(jugador.id).emit(
            "trampaCooldown",
            restante
        );

        return;
    }

    x = Number(x);
    y = Number(y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
    }

    x = limitarNumero(x, 30, ANCHO_MAPA - 30);
    y = limitarNumero(y, 30, ALTO_MAPA - 30);

    // Evitar colocar demasiadas trampas juntas
    const demasiadoCerca = sala.trampas.some(trampa => {

        return distancia(
            x,
            y,
            trampa.x,
            trampa.y
        ) < 70;

    });

    if (demasiadoCerca) {
        return;
    }

    const trampa = {

        id:
            Date.now().toString(36) +
            Math.random().toString(36).substring(2, 7),

        x,
        y,

        creadaPor: jugador.id,

        creadaEn: ahora
    };

    sala.trampas.push(trampa);

    jugador.ultimaTrampa = ahora;

    io.to(sala.codigo).emit(
        "trampaColocada",
        trampa
    );

    io.to(jugador.id).emit(
        "trampaCooldown",
        COOLDOWN_TRAMPA
    );
}

// ==========================================
// COMPROBAR TRAMPAS
// ==========================================

function comprobarTrampas(sala) {

    if (!sala.iniciada || sala.terminada) {
        return;
    }

    for (let i = sala.trampas.length - 1; i >= 0; i--) {

        const trampa = sala.trampas[i];

        let activada = false;

        for (const id in sala.jugadores) {

            const jugador = sala.jugadores[id];

            if (
                jugador.rol !== "aliado" ||
                jugador.muerto
            ) {
                continue;
            }

            const distanciaJugador =
                distancia(
                    jugador.x,
                    jugador.y,
                    trampa.x,
                    trampa.y
                );

            if (distanciaJugador <= RADIO_TRAMPA) {

                jugador.ralentizadoHasta =
                    Date.now() +
                    DURACION_RALENTIZADO;

                io.to(jugador.id).emit(
                    "aliadoRalentizado",
                    {
                        duracion: DURACION_RALENTIZADO
                    }
                );

                io.to(sala.codigo).emit(
                    "trampaActivada",
                    {
                        trampaId: trampa.id,
                        jugadorId: jugador.id
                    }
                );

                sala.trampas.splice(i, 1);

                activada = true;

                break;
            }
        }

        if (activada) {
            continue;
        }
    }
}

// ==========================================
// SOCKET.IO
// ==========================================

io.on("connection", socket => {

    console.log(
        "Jugador conectado:",
        socket.id
    );

    // ======================================
    // CREAR SALA
    // ======================================

    socket.on("crearSala", datos => {

        const codigo = generarCodigoSala();

        const nombre =
            datos?.nombre ||
            "Jugador";

        const sala = {

            codigo,

            jugadores: {},

            trampas: [],

            iniciada: false,

            terminada: false
        };

        salas[codigo] = sala;

        const jugador =
            crearJugador(
                socket.id,
                nombre
            );

        sala.jugadores[socket.id] = jugador;

        socket.join(codigo);

        socket.data.sala = codigo;

        socket.emit(
            "salaCreada",
            {
                codigo
            }
        );

        actualizarRoles(sala);

        enviarEstado(sala);

        console.log(
            `Sala ${codigo} creada`
        );
    });

    // ======================================
    // UNIRSE A SALA
    // ======================================

    socket.on("unirseSala", datos => {

        const codigo =
            String(datos?.codigo || "")
                .trim()
                .toUpperCase();

        const nombre =
            datos?.nombre ||
            "Jugador";

        const sala = salas[codigo];

        if (!sala) {

            socket.emit(
                "errorSala",
                "La sala no existe."
            );

            return;
        }

        if (sala.iniciada) {

            socket.emit(
                "errorSala",
                "La partida ya comenzó."
            );

            return;
        }

        if (
            Object.keys(sala.jugadores).length >=
            MAX_JUGADORES
        ) {

            socket.emit(
                "errorSala",
                "La sala está llena."
            );

            return;
        }

        const jugador =
            crearJugador(
                socket.id,
                nombre
            );

        sala.jugadores[socket.id] = jugador;

        socket.join(codigo);

        socket.data.sala = codigo;

        socket.emit(
            "salaUnida",
            {
                codigo
            }
        );

        actualizarRoles(sala);

        enviarEstado(sala);

        intentarComenzarPartida(sala);
    });

    // ======================================
    // ELEGIR ROL
    // ======================================

    socket.on("elegirRol", rol => {

        const codigo = socket.data.sala;

        if (!codigo) return;

        const sala = salas[codigo];

        if (!sala) return;

        const jugador =
            sala.jugadores[socket.id];

        if (!jugador) return;

        if (sala.iniciada) {

            socket.emit(
                "errorRol",
                "La partida ya comenzó."
            );

            return;
        }

        if (
            rol !== "aliado" &&
            rol !== "enemigo"
        ) {

            socket.emit(
                "errorRol",
                "Rol inválido."
            );

            return;
        }

        const conteo =
            contarRoles(sala);

        if (
            rol === "aliado" &&
            conteo.aliados >= MAX_ALIADOS
        ) {

            socket.emit(
                "errorRol",
                "Ya hay 3 aliados."
            );

            return;
        }

        if (
            rol === "enemigo" &&
            conteo.enemigos >= MAX_ENEMIGOS
        ) {

            socket.emit(
                "errorRol",
                "Ya hay un enemigo."
            );

            return;
        }

        jugador.rol = rol;

        actualizarRoles(sala);

        enviarEstado(sala);

        intentarComenzarPartida(sala);
    });

    // ======================================
    // MOVIMIENTO
    // ======================================

    socket.on("moverJugador", datos => {

        const codigo = socket.data.sala;

        if (!codigo) return;

        const sala = salas[codigo];

        if (!sala) return;

        if (!sala.iniciada || sala.terminada) {
            return;
        }

        const jugador =
            sala.jugadores[socket.id];

        if (!jugador) return;

        if (jugador.muerto) return;

        let nuevoX = Number(datos?.x);
        let nuevoY = Number(datos?.y);

        if (
            !Number.isFinite(nuevoX) ||
            !Number.isFinite(nuevoY)
        ) {
            return;
        }

        const ahora = Date.now();

        const deltaTiempo =
            Math.min(
                ahora - jugador.ultimaActualizacion,
                100
            );

        jugador.ultimaActualizacion = ahora;

        // ==================================
        // VALIDACIÓN DE MOVIMIENTO
        // ==================================

        const velocidad =
            obtenerVelocidad(jugador);

        /*
         * Permitimos un pequeño margen debido
         * a diferencias entre FPS y latencia.
         */

        const distanciaMaxima =
            velocidad *
            (deltaTiempo / 16.666) *
            1.8 +
            8;

        const distanciaSolicitada =
            distancia(
                jugador.x,
                jugador.y,
                nuevoX,
                nuevoY
            );

        if (
            distanciaSolicitada >
            distanciaMaxima
        ) {

            const dx =
                nuevoX - jugador.x;

            const dy =
                nuevoY - jugador.y;

            const factor =
                distanciaMaxima /
                distanciaSolicitada;

            nuevoX =
                jugador.x +
                dx * factor;

            nuevoY =
                jugador.y +
                dy * factor;
        }

        // ==================================
        // LÍMITES DEL MAPA
        // ==================================

        nuevoX =
            limitarNumero(
                nuevoX,
                20,
                ANCHO_MAPA - 20
            );

        nuevoY =
            limitarNumero(
                nuevoY,
                20,
                ALTO_MAPA - 20
            );

        jugador.x = nuevoX;
        jugador.y = nuevoY;

        // ==================================
        // COMPROBAR META
        // ==================================

        comprobarVictoria(sala);
    });

    // ======================================
    // COLOCAR TRAMPA
    // ======================================

    socket.on("colocarTrampa", datos => {

        const codigo = socket.data.sala;

        if (!codigo) return;

        const sala = salas[codigo];

        if (!sala) return;

        const jugador =
            sala.jugadores[socket.id];

        if (!jugador) return;

        colocarTrampa(
            sala,
            jugador,
            datos?.x,
            datos?.y
        );
    });

    // ======================================
    // DESCONECTAR
    // ======================================

    socket.on("disconnect", () => {

        const codigo = socket.data.sala;

        if (!codigo) {
            console.log(
                "Jugador desconectado:",
                socket.id
            );

            return;
        }

        const sala = salas[codigo];

        if (!sala) return;

        delete sala.jugadores[socket.id];

        console.log(
            `Jugador ${socket.id} salió de ${codigo}`
        );

        // Si no queda nadie, eliminar sala
        if (
            Object.keys(sala.jugadores).length === 0
        ) {

            delete salas[codigo];

            console.log(
                `Sala ${codigo} eliminada`
            );

            return;
        }

        // Si la partida estaba comenzada,
        // detenerla para evitar estados incompletos.
        if (sala.iniciada) {

            sala.terminada = true;

            io.to(codigo).emit(
                "jugadorDesconectado",
                {
                    jugadorId: socket.id
                }
            );

        } else {

            actualizarRoles(sala);
            enviarEstado(sala);
        }
    });
});

// ==========================================
// LOOP DEL SERVIDOR
// ==========================================

setInterval(() => {

    const ahora = Date.now();

    for (const codigo in salas) {

        const sala = salas[codigo];

        if (!sala.iniciada) {
            continue;
        }

        if (sala.terminada) {
            continue;
        }

        // Limpiar ralentizaciones vencidas
        for (const id in sala.jugadores) {

            const jugador =
                sala.jugadores[id];

            if (
                jugador.ralentizadoHasta > 0 &&
                ahora >= jugador.ralentizadoHasta
            ) {

                jugador.ralentizadoHasta = 0;
            }
        }

        comprobarTrampas(sala);

        comprobarVictoria(sala);

        enviarEstado(sala);
    }

}, INTERVALO_ESTADO);

// ==========================================
// INICIAR SERVIDOR
// ==========================================

server.listen(PORT, () => {

    console.log(
        `Servidor iniciado en http://localhost:${PORT}`
    );

});
