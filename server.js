const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const salas = new Map();

// ===============================
// CONFIGURACIÓN DEL JUEGO
// ===============================

const ANCHO_MAPA = 5000;
const ALTO_MAPA = 600;

const META_X = ANCHO_MAPA - 150;

const VELOCIDAD_ALIADO = 5;
const VELOCIDAD_ENEMIGO = 3.5;

const DURACION_RALENTIZADO = 4000;
const MULTIPLICADOR_RALENTIZADO = 0.45;

const RADIO_JUGADOR = 20;
const RADIO_CONTACTO = 40;
const RADIO_TRAMPA = 28;

const TIEMPO_COOLDOWN_TRAMPA = 5000;

// ===============================
// GENERAR CÓDIGO DE SALA
// ===============================

function generarCodigo() {

    const caracteres =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let codigo = "";

    for (let i = 0; i < 5; i++) {

        codigo += caracteres.charAt(
            Math.floor(
                Math.random() * caracteres.length
            )
        );

    }

    return codigo;
}

// ===============================
// CREAR ESTADO DE UNA SALA
// ===============================

function crearEstadoSala() {

    return {
        iniciada: false,
        finalizada: false,
        trampas: [],
        siguienteTrampaId: 1
    };

}

// ===============================
// ENVIAR JUGADORES
// ===============================

function enviarJugadores(codigo) {

    const sala = salas.get(codigo);

    if (!sala) return;

    const jugadores =
        Array.from(sala.jugadores.values()).map(jugador => ({
            id: jugador.id,
            x: jugador.x,
            y: jugador.y,
            rol: jugador.rol,
            muerto: jugador.muerto,
            ralentizadoHasta: jugador.ralentizadoHasta || 0
        }));

    io.to(codigo).emit(
        "actualizarJugadores",
        jugadores
    );
}

// ===============================
// ENVIAR ESTADO DEL MAPA
// ===============================

function enviarEstadoMapa(codigo) {

    const sala = salas.get(codigo);

    if (!sala) return;

    io.to(codigo).emit(
        "actualizarMapa",
        {
            ancho: ANCHO_MAPA,
            alto: ALTO_MAPA,
            metaX: META_X,
            trampas: sala.estado.trampas
        }
    );

}

// ===============================
// ENVIAR ROLES
// ===============================

function enviarRoles(codigo) {

    const sala = salas.get(codigo);

    if (!sala) return;

    let aliados = 0;
    let enemigo = false;

    for (const jugador of sala.jugadores.values()) {

        if (jugador.rol === "aliado") {
            aliados++;
        }

        if (jugador.rol === "enemigo") {
            enemigo = true;
        }

    }

    io.to(codigo).emit(
        "actualizarRoles",
        {
            aliados: aliados,
            enemigo: enemigo
        }
    );
}

// ===============================
// COMPROBAR SI LA PARTIDA PUEDE EMPEZAR
// ===============================

function partidaLista(codigo) {

    const sala = salas.get(codigo);

    if (!sala) return false;

    if (sala.jugadores.size !== 4) {
        return false;
    }

    let aliados = 0;
    let enemigos = 0;

    for (const jugador of sala.jugadores.values()) {

        if (jugador.rol === "aliado") {
            aliados++;
        }

        if (jugador.rol === "enemigo") {
            enemigos++;
        }

    }

    return aliados === 3 && enemigos === 1;
}

// ===============================
// CREAR JUGADOR
// ===============================

function crearJugador(id, x) {

    return {
        id: id,

        x: x,
        y: ALTO_MAPA / 2,

        rol: null,

        muerto: false,

        ralentizadoHasta: 0,

        ultimaPosicionValida: {
            x: x,
            y: ALTO_MAPA / 2
        },

        ultimoMovimiento: Date.now(),

        ultimoUsoTrampa: 0
    };

}

// ===============================
// REINICIAR PARTIDA
// ===============================

function reiniciarPartida(codigo) {

    const sala = salas.get(codigo);

    if (!sala) return;

    sala.estado.iniciada = true;
    sala.estado.finalizada = false;
    sala.estado.trampas = [];
    sala.estado.siguienteTrampaId = 1;

    for (const jugador of sala.jugadores.values()) {

        jugador.muerto = false;
        jugador.ralentizadoHasta = 0;
        jugador.ultimoMovimiento = Date.now();
        jugador.ultimoUsoTrampa = 0;

        if (jugador.rol === "enemigo") {

            jugador.x = 300;

        } else {

            jugador.x = 150;

        }

        jugador.y =
            ALTO_MAPA / 2 +
            (Math.random() * 160 - 80);

        jugador.ultimaPosicionValida = {
            x: jugador.x,
            y: jugador.y
        };

    }

    io.to(codigo).emit("partidaIniciada");

    enviarJugadores(codigo);
    enviarEstadoMapa(codigo);

}

// ===============================
// COMPROBAR VICTORIA DEL ENEMIGO
// ===============================

function comprobarVictoriaEnemigo(codigo) {

    const sala = salas.get(codigo);

    if (!sala || sala.estado.finalizada) return;

    let aliadosMuertos = 0;

    for (const jugador of sala.jugadores.values()) {

        if (
            jugador.rol === "aliado" &&
            jugador.muerto
        ) {

            aliadosMuertos++;

        }

    }

    if (aliadosMuertos >= 3) {

        sala.estado.finalizada = true;

        io.to(codigo).emit(
            "enemigoGana"
        );

    }

}

// ===============================
// COMPROBAR VICTORIA DE LOS ALIADOS
// ===============================

function comprobarVictoriaAliados(codigo) {

    const sala = salas.get(codigo);

    if (!sala || sala.estado.finalizada) return;

    for (const jugador of sala.jugadores.values()) {

        if (
            jugador.rol === "aliado" &&
            !jugador.muerto &&
            jugador.x >= META_X
        ) {

            sala.estado.finalizada = true;

            io.to(codigo).emit(
                "aliadosGanan",
                {
                    id: jugador.id
                }
            );

            return;
        }

    }

}

// ===============================
// DETECTAR CONTACTO ENEMIGO / ALIADO
// ===============================

function comprobarContactoEnemigo(codigo, enemigo) {

    const sala = salas.get(codigo);

    if (!sala || sala.estado.finalizada) return;

    for (const aliado of sala.jugadores.values()) {

        if (aliado.rol !== "aliado") {
            continue;
        }

        if (aliado.muerto) {
            continue;
        }

        const dx = enemigo.x - aliado.x;
        const dy = enemigo.y - aliado.y;

        const distancia =
            Math.sqrt(
                dx * dx +
                dy * dy
            );

        if (distancia < RADIO_CONTACTO) {

            aliado.muerto = true;

            io.to(codigo).emit(
                "aliadoMuerto",
                {
                    id: aliado.id
                }
            );

            console.log(
                `El enemigo ${enemigo.id} eliminó a ${aliado.id}`
            );

        }

    }

    comprobarVictoriaEnemigo(codigo);

}

// ===============================
// ACTIVAR TRAMPAS
// ===============================

function comprobarTrampas(codigo, jugador) {

    const sala = salas.get(codigo);

    if (!sala || sala.estado.finalizada) return;

    if (jugador.rol !== "aliado") {
        return;
    }

    if (jugador.muerto) {
        return;
    }

    for (let i = sala.estado.trampas.length - 1; i >= 0; i--) {

        const trampa =
            sala.estado.trampas[i];

        const dx =
            jugador.x - trampa.x;

        const dy =
            jugador.y - trampa.y;

        const distancia =
            Math.sqrt(
                dx * dx +
                dy * dy
            );

        if (distancia <= RADIO_TRAMPA) {

            jugador.ralentizadoHasta =
                Date.now() + DURACION_RALENTIZADO;

            sala.estado.trampas.splice(i, 1);

            io.to(codigo).emit(
                "aliadoRalentizado",
                {
                    id: jugador.id,
                    duracion: DURACION_RALENTIZADO
                }
            );

            console.log(
                `El aliado ${jugador.id} activó una trampa`
            );

            enviarEstadoMapa(codigo);

        }

    }

}

// ===============================
// CONEXIÓN
// ===============================

io.on("connection", (socket) => {

    console.log(
        "Jugador conectado:",
        socket.id
    );

    // ===========================
    // CREAR SALA
    // ===========================

    socket.on("crearSala", () => {

        let codigo;

        do {

            codigo = generarCodigo();

        } while (salas.has(codigo));

        salas.set(
            codigo,
            {
                jugadores: new Map(),
                estado: crearEstadoSala()
            }
        );

        socket.join(codigo);
        socket.sala = codigo;

        const jugador =
            crearJugador(
                socket.id,
                150
            );

        salas
            .get(codigo)
            .jugadores
            .set(
                socket.id,
                jugador
            );

        socket.emit(
            "salaCreada",
            {
                codigo: codigo,
                jugadores: 1
            }
        );

        enviarJugadores(codigo);
        enviarRoles(codigo);
        enviarEstadoMapa(codigo);

        console.log(
            `Sala ${codigo} creada`
        );

    });

    // ===========================
    // UNIRSE A SALA
    // ===========================

    socket.on(
        "unirseSala",
        (codigoRecibido) => {

            const codigo =
                String(codigoRecibido)
                    .trim()
                    .toUpperCase();

            const sala =
                salas.get(codigo);

            if (!sala) {

                socket.emit(
                    "errorSala",
                    "La sala no existe."
                );

                return;
            }

            if (sala.jugadores.size >= 4) {

                socket.emit(
                    "errorSala",
                    "La sala está llena."
                );

                return;
            }

            socket.join(codigo);
            socket.sala = codigo;

            const jugador =
                crearJugador(
                    socket.id,
                    150
                );

            sala.jugadores.set(
                socket.id,
                jugador
            );

            socket.emit(
                "salaCreada",
                {
                    codigo: codigo,
                    jugadores: sala.jugadores.size
                }
            );

            enviarJugadores(codigo);
            enviarRoles(codigo);
            enviarEstadoMapa(codigo);

            console.log(
                `Jugador ${socket.id} se unió a ${codigo}`
            );

        }
    );

    // ===========================
    // ELEGIR ROL
    // ===========================

    socket.on(
        "elegirRol",
        (rol) => {

            if (!socket.sala) return;

            const sala =
                salas.get(socket.sala);

            if (!sala) return;

            const jugador =
                sala.jugadores.get(socket.id);

            if (!jugador) return;

            if (sala.estado.iniciada) {
                return;
            }

            if (
                rol !== "aliado" &&
                rol !== "enemigo"
            ) {
                return;
            }

            // =========================
            // ENEMIGO
            // =========================

            if (rol === "enemigo") {

                for (
                    const otro of sala.jugadores.values()
                ) {

                    if (
                        otro.rol === "enemigo" &&
                        otro.id !== socket.id
                    ) {

                        socket.emit(
                            "errorRol",
                            "Ya hay un enemigo en esta sala."
                        );

                        return;

                    }

                }

            }

            // =========================
            // ALIADO
            // =========================

            if (rol === "aliado") {

                let cantidadAliados = 0;

                for (
                    const otro of sala.jugadores.values()
                ) {

                    if (
                        otro.rol === "aliado" &&
                        otro.id !== socket.id
                    ) {

                        cantidadAliados++;

                    }

                }

                if (cantidadAliados >= 3) {

                    socket.emit(
                        "errorRol",
                        "Ya hay 3 aliados."
                    );

                    return;

                }

            }

            jugador.rol = rol;

            enviarJugadores(socket.sala);
            enviarRoles(socket.sala);

            // =========================
            // INICIAR PARTIDA
            // =========================

            if (partidaLista(socket.sala)) {

                reiniciarPartida(socket.sala);

            }

        }
    );

    // ===========================
    // MOVIMIENTO
    // ===========================

    socket.on(
        "moverJugador",
        (posicion) => {

            if (!socket.sala) return;

            const sala =
                salas.get(socket.sala);

            if (!sala) return;

            const jugador =
                sala.jugadores.get(socket.id);

            if (!jugador) return;

            if (!sala.estado.iniciada) {
                return;
            }

            if (sala.estado.finalizada) {
                return;
            }

            if (jugador.muerto) {
                return;
            }

            if (
                !posicion ||
                typeof posicion.x !== "number" ||
                typeof posicion.y !== "number"
            ) {
                return;
            }

            const ahora = Date.now();

            const deltaTiempo =
                Math.min(
                    ahora - jugador.ultimoMovimiento,
                    100
                );

            jugador.ultimoMovimiento = ahora;

            // =========================
            // VELOCIDAD SEGÚN ROL
            // =========================

            let velocidad =
                jugador.rol === "enemigo"
                    ? VELOCIDAD_ENEMIGO
                    : VELOCIDAD_ALIADO;

            // =========================
            // RALENTIZACIÓN
            // =========================

            if (
                jugador.ralentizadoHasta &&
                jugador.ralentizadoHasta > ahora
            ) {

                velocidad *=
                    MULTIPLICADOR_RALENTIZADO;

            } else {

                jugador.ralentizadoHasta = 0;

            }

            // =========================
            // LÍMITE DE MOVIMIENTO
            // =========================

            const dx =
                posicion.x - jugador.x;

            const dy =
                posicion.y - jugador.y;

            const distancia =
                Math.sqrt(
                    dx * dx +
                    dy * dy
                );

            const maximoMovimiento =
                velocidad *
                Math.max(
                    1,
                    deltaTiempo / 16.67
                );

            let nuevaX = posicion.x;
            let nuevaY = posicion.y;

            if (distancia > maximoMovimiento) {

                const factor =
                    maximoMovimiento /
                    distancia;

                nuevaX =
                    jugador.x +
                    dx * factor;

                nuevaY =
                    jugador.y +
                    dy * factor;

            }

            // =========================
            // LÍMITES DEL MAPA
            // =========================

            nuevaX =
                Math.max(
                    RADIO_JUGADOR,
                    Math.min(
                        ANCHO_MAPA - RADIO_JUGADOR,
                        nuevaX
                    )
                );

            nuevaY =
                Math.max(
                    RADIO_JUGADOR,
                    Math.min(
                        ALTO_MAPA - RADIO_JUGADOR,
                        nuevaY
                    )
                );

            jugador.x = nuevaX;
            jugador.y = nuevaY;

            jugador.ultimaPosicionValida = {
                x: jugador.x,
                y: jugador.y
            };

            // =========================
            // CONTACTO CON ENEMIGO
            // =========================

            if (jugador.rol === "enemigo") {

                comprobarContactoEnemigo(
                    socket.sala,
                    jugador
                );

            }

            // =========================
            // TRAMPAS
            // =========================

            if (jugador.rol === "aliado") {

                comprobarTrampas(
                    socket.sala,
                    jugador
                );

                comprobarVictoriaAliados(
                    socket.sala
                );

            }

            enviarJugadores(socket.sala);

        }
    );

    // ===========================
    // COLOCAR TRAMPA
    // ===========================

    socket.on(
        "colocarTrampa",
        (posicion) => {

            if (!socket.sala) return;

            const sala =
                salas.get(socket.sala);

            if (!sala) return;

            const jugador =
                sala.jugadores.get(socket.id);

            if (!jugador) return;

            if (!sala.estado.iniciada) {
                return;
            }

            if (sala.estado.finalizada) {
                return;
            }

            if (jugador.rol !== "enemigo") {
                return;
            }

            if (jugador.muerto) {
                return;
            }

            if (
                !posicion ||
                typeof posicion.x !== "number" ||
                typeof posicion.y !== "number"
            ) {
                return;
            }

            const ahora = Date.now();

            // =========================
            // COOLDOWN
            // =========================

            if (
                ahora - jugador.ultimoUsoTrampa <
                TIEMPO_COOLDOWN_TRAMPA
            ) {

                const restante =
                    TIEMPO_COOLDOWN_TRAMPA -
                    (ahora - jugador.ultimoUsoTrampa);

                socket.emit(
                    "trampaCooldown",
                    {
                        restante: restante
                    }
                );

                return;

            }

            // =========================
            // POSICIÓN REAL DEL MAPA
            // =========================

            const x =
                Math.max(
                    30,
                    Math.min(
                        ANCHO_MAPA - 30,
                        posicion.x
                    )
                );

            const y =
                Math.max(
                    30,
                    Math.min(
                        ALTO_MAPA - 30,
                        posicion.y
                    )
                );

            const trampa = {

                id:
                    sala.estado.siguienteTrampaId++,

                x: x,

                y: y

            };

            sala.estado.trampas.push(
                trampa
            );

            jugador.ultimoUsoTrampa =
                ahora;

            io.to(socket.sala).emit(
                "trampaColocada",
                trampa
            );

            enviarEstadoMapa(
                socket.sala
            );

            console.log(
                `El enemigo ${jugador.id} colocó una trampa en ${x}, ${y}`
            );

        }
    );

    // ===========================
    // DESCONECTAR
    // ===========================

    socket.on(
        "disconnect",
        () => {

            if (!socket.sala) {
                return;
            }

            const sala =
                salas.get(socket.sala);

            if (!sala) {
                return;
            }

            sala.jugadores.delete(
                socket.id
            );

            if (sala.jugadores.size === 0) {

                salas.delete(
                    socket.sala
                );

            } else {

                enviarJugadores(
                    socket.sala
                );

                enviarRoles(
                    socket.sala
                );

                enviarEstadoMapa(
                    socket.sala
                );

            }

            console.log(
                "Jugador desconectado:",
                socket.id
            );

        }
    );

});

// ===============================
// SERVIDOR
// ===============================

const PORT =
    process.env.PORT || 3000;

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Servidor iniciado en el puerto ${PORT}`
        );

    }
);
