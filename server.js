const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ================================
// CONFIGURACIÓN DEL JUEGO
// ================================

const ANCHO_MAPA = 5000;
const ALTO_MAPA = 600;
const META_X = 4800;

const VELOCIDAD_ALIADO = 5;
const VELOCIDAD_ENEMIGO = 3.5;

const RADIO_JUGADOR = 20;
const RADIO_TRAMPA = 32;

const DURACION_RALENTIZADO = 4000;
const MULTIPLICADOR_RALENTIZADO = 0.45;
const COOLDOWN_TRAMPA = 3000;

const salas = new Map();

// ================================
// UTILIDADES
// ================================

function generarCodigo() {
    const caracteres = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let codigo = "";

    for (let i = 0; i < 5; i++) {
        codigo += caracteres.charAt(
            Math.floor(Math.random() * caracteres.length)
        );
    }

    return codigo;
}

function obtenerSala(codigo) {
    return salas.get(codigo);
}

function crearJugador(id) {
    return {
        id,
        x: 160,
        y: ALTO_MAPA / 2,
        rol: null,
        muerto: false,
        ralentizadoHasta: 0
    };
}

function listarJugadores(sala) {
    return Array.from(sala.jugadores.values()).map(j => ({
        id: j.id,
        x: j.x,
        y: j.y,
        rol: j.rol,
        muerto: j.muerto,
        ralentizado: j.ralentizadoHasta > Date.now()
    }));
}

function contarRoles(sala) {
    let aliados = 0;
    let enemigos = 0;

    for (const jugador of sala.jugadores.values()) {
        if (jugador.rol === "aliado") aliados++;
        if (jugador.rol === "enemigo") enemigos++;
    }

    return { aliados, enemigos };
}

function emitirEstado(codigo) {
    const sala = obtenerSala(codigo);
    if (!sala) return;

    io.to(codigo).emit("actualizarJugadores", listarJugadores(sala));

    const roles = contarRoles(sala);

    io.to(codigo).emit("actualizarRoles", {
        aliados: roles.aliados,
        enemigo: roles.enemigos > 0,
        enemigos: roles.enemigos,
        jugadores: sala.jugadores.size,
        partidaComenzada: sala.partidaComenzada,
        partidaTerminada: sala.partidaTerminada
    });

    io.to(codigo).emit(
        "actualizarTrampas",
        Array.from(sala.trampas.values())
    );
}

function iniciarPartidaSiLista(codigo) {
    const sala = obtenerSala(codigo);
    if (!sala || sala.partidaComenzada || sala.partidaTerminada) return;

    if (sala.jugadores.size !== 4) return;

    const roles = contarRoles(sala);

    if (roles.aliados !== 3 || roles.enemigos !== 1) return;

    sala.partidaComenzada = true;
    sala.trampas.clear();
    sala.ultimaTrampaPorJugador.clear();

    for (const jugador of sala.jugadores.values()) {
        jugador.x = 160;
        jugador.y = ALTO_MAPA / 2;
        jugador.muerto = false;
        jugador.ralentizadoHasta = 0;
    }

    io.to(codigo).emit("partidaIniciada", {
        anchoMapa: ANCHO_MAPA,
        altoMapa: ALTO_MAPA,
        metaX: META_X
    });

    emitirEstado(codigo);
}

function terminarPartida(codigo, ganador, motivo) {
    const sala = obtenerSala(codigo);
    if (!sala || sala.partidaTerminada) return;

    sala.partidaTerminada = true;
    sala.partidaComenzada = false;
    sala.ganador = ganador;

    io.to(codigo).emit("partidaTerminada", {
        ganador,
        motivo
    });

    emitirEstado(codigo);
}

function comprobarMeta(codigo) {
    const sala = obtenerSala(codigo);
    if (!sala || sala.partidaTerminada) return;

    for (const jugador of sala.jugadores.values()) {
        if (
            jugador.rol === "aliado" &&
            !jugador.muerto &&
            jugador.x >= META_X
        ) {
            terminarPartida(
                codigo,
                "aliados",
                "¡Un aliado llegó a la meta!"
            );
            return;
        }
    }
}

function comprobarTrampas(codigo, jugador) {
    const sala = obtenerSala(codigo);
    if (!sala || jugador.rol !== "aliado" || jugador.muerto) return;

    for (const [id, trampa] of sala.trampas.entries()) {
        const dx = jugador.x - trampa.x;
        const dy = jugador.y - trampa.y;
        const distancia = Math.sqrt(dx * dx + dy * dy);

        if (distancia < RADIO_JUGADOR + RADIO_TRAMPA) {
            jugador.ralentizadoHasta =
                Date.now() + DURACION_RALENTIZADO;

            sala.trampas.delete(id);

            io.to(codigo).emit("trampaActivada", {
                jugadorId: jugador.id,
                duracion: DURACION_RALENTIZADO
            });

            io.to(codigo).emit(
                "actualizarTrampas",
                Array.from(sala.trampas.values())
            );

            break;
        }
    }
}

function comprobarColisionEnemigo(codigo, enemigo) {
    const sala = obtenerSala(codigo);
    if (!sala || enemigo.rol !== "enemigo") return;

    for (const aliado of sala.jugadores.values()) {
        if (
            aliado.rol !== "aliado" ||
            aliado.muerto
        ) {
            continue;
        }

        const dx = enemigo.x - aliado.x;
        const dy = enemigo.y - aliado.y;
        const distancia = Math.sqrt(dx * dx + dy * dy);

        if (distancia < RADIO_JUGADOR * 2) {
            aliado.muerto = true;
            aliado.ralentizadoHasta = 0;

            io.to(codigo).emit("aliadoMuerto", {
                jugadorId: aliado.id
            });
        }
    }

    const aliadosVivos = Array.from(sala.jugadores.values()).filter(
        j => j.rol === "aliado" && !j.muerto
    );

    if (aliadosVivos.length === 0) {
        terminarPartida(
            codigo,
            "enemigo",
            "El enemigo eliminó a los tres aliados."
        );
    }
}

// ================================
// CONEXIONES
// ================================

io.on("connection", socket => {
    console.log("Jugador conectado:", socket.id);

    // Crear una sala
    socket.on("crearSala", () => {
        let codigo;

        do {
            codigo = generarCodigo();
        } while (salas.has(codigo));

        salas.set(codigo, {
            jugadores: new Map(),
            trampas: new Map(),
            ultimaTrampaPorJugador: new Map(),
            partidaComenzada: false,
            partidaTerminada: false,
            ganador: null,
            siguienteIdTrampa: 1
        });

        const sala = obtenerSala(codigo);

        socket.join(codigo);
        socket.data.sala = codigo;

        sala.jugadores.set(socket.id, crearJugador(socket.id));

        socket.emit("salaCreada", codigo);
        emitirEstado(codigo);
    });

    // Unirse a una sala existente
    socket.on("unirseSala", codigoRecibido => {
        const codigo = String(codigoRecibido || "")
            .trim()
            .toUpperCase();

        const sala = obtenerSala(codigo);

        if (!sala) {
            socket.emit("errorJuego", "La sala no existe.");
            return;
        }

        if (sala.partidaComenzada || sala.partidaTerminada) {
            socket.emit("errorJuego", "La partida ya comenzó o terminó.");
            return;
        }

        if (sala.jugadores.size >= 4) {
            socket.emit("errorJuego", "La sala está completa.");
            return;
        }

        socket.join(codigo);
        socket.data.sala = codigo;

        sala.jugadores.set(socket.id, crearJugador(socket.id));

        socket.emit("salaUnida", codigo);
        emitirEstado(codigo);
    });

    // Elegir rol
    socket.on("elegirRol", rol => {
        const codigo = socket.data.sala;
        const sala = obtenerSala(codigo);

        if (!sala || sala.partidaComenzada || sala.partidaTerminada) return;
        if (!["aliado", "enemigo"].includes(rol)) return;

        const jugador = sala.jugadores.get(socket.id);
        if (!jugador) return;

        const otroEnemigo = Array.from(sala.jugadores.values()).some(
            j => j.id !== socket.id && j.rol === "enemigo"
        );

        if (rol === "enemigo" && otroEnemigo) {
            socket.emit("errorJuego", "Ya hay un enemigo elegido.");
            return;
        }

        jugador.rol = rol;

        socket.emit("rolElegido", rol);

        emitirEstado(codigo);
        iniciarPartidaSiLista(codigo);
    });

    // Movimiento validado en el servidor
    socket.on("moverJugador", datos => {
        const codigo = socket.data.sala;
        const sala = obtenerSala(codigo);

        if (!sala || !sala.partidaComenzada || sala.partidaTerminada) return;

        const jugador = sala.jugadores.get(socket.id);
        if (!jugador || jugador.muerto || !jugador.rol) return;

        const x = Number(datos?.x);
        const y = Number(datos?.y);

        if (!Number.isFinite(x) || !Number.isFinite(y)) return;

        const dx = x - jugador.x;
        const dy = y - jugador.y;
        const distancia = Math.sqrt(dx * dx + dy * dy);

        const ahora = Date.now();
        let velocidad = jugador.rol === "enemigo"
            ? VELOCIDAD_ENEMIGO
            : VELOCIDAD_ALIADO;

        if (
            jugador.rol === "aliado" &&
            jugador.ralentizadoHasta > ahora
        ) {
            velocidad *= MULTIPLICADOR_RALENTIZADO;
        }

        // Margen pequeño para tolerar retrasos de red, sin permitir teletransporte.
        const tiempoTranscurrido = Math.min(
            120,
            Math.max(20, ahora - (jugador.ultimaActualizacion || ahora - 50))
        );

        const distanciaMaxima = velocidad * (tiempoTranscurrido / 16.67) + 8;

        if (distancia > distanciaMaxima) return;

        jugador.x = Math.max(
            RADIO_JUGADOR,
            Math.min(ANCHO_MAPA - RADIO_JUGADOR, x)
        );

        jugador.y = Math.max(
            RADIO_JUGADOR,
            Math.min(ALTO_MAPA - RADIO_JUGADOR, y)
        );

        jugador.ultimaActualizacion = ahora;

        comprobarTrampas(codigo, jugador);

        if (jugador.rol === "enemigo") {
            comprobarColisionEnemigo(codigo, jugador);
        }

        comprobarMeta(codigo);
        emitirEstado(codigo);
    });

    // El enemigo coloca una trampa haciendo clic en el mapa.
    socket.on("ponerTrampa", datos => {
        const codigo = socket.data.sala;
        const sala = obtenerSala(codigo);

        if (!sala || !sala.partidaComenzada || sala.partidaTerminada) return;

        const jugador = sala.jugadores.get(socket.id);
        if (!jugador || jugador.rol !== "enemigo" || jugador.muerto) return;

        const x = Number(datos?.x);
        const y = Number(datos?.y);

        if (!Number.isFinite(x) || !Number.isFinite(y)) return;

        const ahora = Date.now();
        const ultima = sala.ultimaTrampaPorJugador.get(socket.id) || 0;
        const restante = COOLDOWN_TRAMPA - (ahora - ultima);

        if (restante > 0) {
            socket.emit("trampaCooldown", restante);
            return;
        }

        // Limitar el número de trampas activas.
        if (sala.trampas.size >= 8) {
            socket.emit("errorJuego", "Ya hay 8 trampas colocadas.");
            return;
        }

        const trampa = {
            id: sala.siguienteIdTrampa++,
            x: Math.max(40, Math.min(ANCHO_MAPA - 40, x)),
            y: Math.max(40, Math.min(ALTO_MAPA - 40, y))
        };

        sala.trampas.set(trampa.id, trampa);
        sala.ultimaTrampaPorJugador.set(socket.id, ahora);

        socket.emit("trampaCooldown", COOLDOWN_TRAMPA);

        io.to(codigo).emit(
            "actualizarTrampas",
            Array.from(sala.trampas.values())
        );
    });

    // Desconexión
    socket.on("disconnect", () => {
        const codigo = socket.data.sala;
        const sala = obtenerSala(codigo);

        if (!sala) return;

        sala.jugadores.delete(socket.id);
        sala.ultimaTrampaPorJugador.delete(socket.id);

        if (sala.jugadores.size === 0) {
            salas.delete(codigo);
            return;
        }

        // Si alguien se desconecta durante una partida, la partida se cancela.
        if (sala.partidaComenzada) {
            sala.partidaComenzada = false;

            io.to(codigo).emit("partidaCancelada", {
                mensaje: "Un jugador se desconectó. Creen otra sala para jugar de nuevo."
            });
        }

        emitirEstado(codigo);
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor iniciado en el puerto ${PORT}`);
});
