const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const salas = new Map();

const ANCHO_CANCHA = 800;
const ALTO_CANCHA = 500;
const RADIO_CONTACTO = 40;
const DURACION_CUENTA = 5;

// --- Reglas de la carrera ---
const META_X = 740;                 // los aliados llegan a la meta con x >= META_X
const TIEMPO_PARTIDA = 120;         // segundos; si se acaba, gana el enemigo
const VEL_ALIADO = 240;             // px/seg (igual que el cliente)
const VEL_ENEMIGO = 180;
const TICK_MS = 1000 / 30;          // el servidor emite el estado 30 veces por segundo
const MAX_DT_MOVIMIENTO_MS = 600;   // tolerancia anti-trampa (lag spikes) en el control de velocidad
const REINICIO_MS = 6000;           // tiempo antes de volver a elegir roles

// --- Trampas ---
const TRAMPA_RADIO = 35;
const TRAMPA_VIDA_MS = 30000;
const TRAMPA_MAX = 5;
const TRAMPA_DISTANCIA_MIN_ALIADO = 80;   // no se puede poner pegada a un aliado
const INMUNIDAD_MS = 1500;                // después de un efecto, no te afecta otra trampa
const TIPOS_TRAMPA = {
    lenta: { duracion: 3000, cooldown: 3000 },   // velocidad al 40%
    hielo: { duracion: 2500, cooldown: 8000 }    // congela por completo
};

// ========================================
// CÓDIGO DE SALA
// ========================================

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

function contarRoles(sala) {
    let aliados = 0;
    let enemigos = 0;

    for (const jugador of sala.jugadores.values()) {
        if (jugador.rol === "aliado") aliados++;
        if (jugador.rol === "enemigo") enemigos++;
    }

    return { aliados, enemigos };
}

// ========================================
// ESTADO Y JUGADORES
// ========================================

function datosJugador(j, ahora) {
    return {
        id: j.id,
        x: j.x,
        y: j.y,
        rol: j.rol,
        muerto: j.muerto,
        llego: !!j.llego,
        congelado: (j.congeladoHasta || 0) > ahora,
        lento: (j.lentoHasta || 0) > ahora
    };
}

function enviarJugadores(codigo) {
    const sala = obtenerSala(codigo);
    if (!sala) return;

    const ahora = Date.now();

    io.to(codigo).emit(
        "actualizarJugadores",
        Array.from(sala.jugadores.values()).map(j => datosJugador(j, ahora))
    );
}

function enviarTrampas(codigo) {
    const sala = obtenerSala(codigo);
    if (!sala) return;

    io.to(codigo).emit(
        "actualizarTrampas",
        sala.trampas.map(t => ({ id: t.id, tipo: t.tipo, x: t.x, y: t.y }))
    );
}

function enviarRoles(codigo) {
    const sala = obtenerSala(codigo);
    if (!sala) return;

    const roles = contarRoles(sala);

    io.to(codigo).emit("actualizarRoles", {
        aliados: roles.aliados,
        enemigo: roles.enemigos > 0
    });
}

function partidaLista(sala) {
    if (!sala || sala.jugadores.size !== 4) return false;

    const roles = contarRoles(sala);
    return roles.aliados === 3 && roles.enemigos === 1;
}

function cancelarCuentaRegresiva(codigo) {
    const sala = obtenerSala(codigo);
    if (!sala) return;

    if (sala.timerCuenta) {
        clearInterval(sala.timerCuenta);
        sala.timerCuenta = null;
    }

    if (sala.enCuentaRegresiva) {
        sala.enCuentaRegresiva = false;
        io.to(codigo).emit("cuentaRegresivaCancelada");
    }
}

// ========================================
// INICIAR CON CUENTA REGRESIVA
// ========================================

function iniciarCuentaRegresiva(codigo) {
    const sala = obtenerSala(codigo);

    if (
        !sala ||
        sala.partidaComenzada ||
        sala.partidaTerminada ||
        sala.enCuentaRegresiva ||
        !partidaLista(sala)
    ) {
        return;
    }

    sala.enCuentaRegresiva = true;

    let segundos = DURACION_CUENTA;

    io.to(codigo).emit("cuentaRegresiva", segundos);

    sala.timerCuenta = setInterval(() => {
        const salaActual = obtenerSala(codigo);

        if (!salaActual) {
            clearInterval(sala.timerCuenta);
            return;
        }

        if (!partidaLista(salaActual)) {
            cancelarCuentaRegresiva(codigo);
            return;
        }

        segundos--;

        if (segundos > 0) {
            io.to(codigo).emit("cuentaRegresiva", segundos);
            return;
        }

        clearInterval(sala.timerCuenta);
        sala.timerCuenta = null;
        sala.enCuentaRegresiva = false;
        sala.partidaComenzada = true;
        sala.partidaTerminada = false;

        // Los aliados aparecen a la izquierda.
        const posicionesAliados = [
            { x: 100, y: 120 },
            { x: 100, y: 250 },
            { x: 100, y: 380 }
        ];

        let indiceAliado = 0;

        sala.trampas = [];
        sala.cooldownsTrampa = { lenta: 0, hielo: 0 };
        sala.finPartida = Date.now() + TIEMPO_PARTIDA * 1000;
        sala.ultimoTiempoEnviado = -1;
        sala.sucio = true;

        for (const jugador of sala.jugadores.values()) {
            jugador.muerto = false;
            jugador.llego = false;
            jugador.congeladoHasta = 0;
            jugador.lentoHasta = 0;
            jugador.inmuneHasta = 0;
            jugador.ultimoMov = Date.now();
            jugador.estadoVisual = "";

            if (jugador.rol === "aliado") {
                const posicion = posicionesAliados[indiceAliado++];
                jugador.x = posicion.x;
                jugador.y = posicion.y;
            } else {
                // El enemigo empieza bien lejos de los aliados.
                jugador.x = 560;
                jugador.y = 250;
            }
        }

        io.to(codigo).emit("partidaIniciada", {
            ancho: ANCHO_CANCHA,
            alto: ALTO_CANCHA
        });

        enviarJugadores(codigo);
        enviarTrampas(codigo);
        console.log(`Partida iniciada en sala ${codigo}`);
    }, 1000);
}

// ========================================
// FIN DE PARTIDA Y REINICIO
// ========================================

function resetearSala(codigo) {
    const sala = obtenerSala(codigo);
    if (!sala) return;

    if (sala.timerReset) {
        clearTimeout(sala.timerReset);
        sala.timerReset = null;
    }

    sala.partidaComenzada = false;
    sala.partidaTerminada = false;
    sala.enCuentaRegresiva = false;
    sala.trampas = [];

    for (const j of sala.jugadores.values()) {
        j.rol = null;
        j.muerto = false;
        j.llego = false;
        j.congeladoHasta = 0;
        j.lentoHasta = 0;
    }

    io.to(codigo).emit("volverASeleccion");
    enviarJugadores(codigo);
    enviarRoles(codigo);
}

function terminarPartida(codigo, sala, evento, datos) {
    if (sala.partidaTerminada) return;

    sala.partidaTerminada = true;
    sala.partidaComenzada = false;

    io.to(codigo).emit(evento, datos);
    enviarJugadores(codigo);

    sala.timerReset = setTimeout(() => resetearSala(codigo), REINICIO_MS);
}

// ========================================
// SIMULACIÓN DEL SERVIDOR (contactos, trampas, meta)
// ========================================

function actualizarSala(codigo, sala, ahora) {
    const jugadores = [...sala.jugadores.values()];
    const enemigo = jugadores.find(j => j.rol === "enemigo");
    const aliados = jugadores.filter(j => j.rol === "aliado");

    // 1) El enemigo toca a un aliado (se chequea siempre, se mueva quien se mueva).
    if (enemigo) {
        for (const aliado of aliados) {
            if (aliado.muerto || aliado.llego) continue;

            const dx = enemigo.x - aliado.x;
            const dy = enemigo.y - aliado.y;

            if (Math.hypot(dx, dy) < RADIO_CONTACTO) {
                aliado.muerto = true;
                sala.sucio = true;
                io.to(codigo).emit("aliadoMuerto", { id: aliado.id });
                console.log(`El enemigo eliminó al aliado ${aliado.id}`);
            }
        }
    }

    // 2) Trampas: vencen con el tiempo o se activan al pisarlas.
    const antes = sala.trampas.length;

    sala.trampas = sala.trampas.filter(trampa => {
        if (ahora >= trampa.venceEn) return false;

        for (const aliado of aliados) {
            if (aliado.muerto || aliado.llego) continue;
            if ((aliado.inmuneHasta || 0) > ahora) continue;

            if (Math.hypot(trampa.x - aliado.x, trampa.y - aliado.y) < TRAMPA_RADIO) {
                const { duracion } = TIPOS_TRAMPA[trampa.tipo];

                if (trampa.tipo === "hielo") {
                    aliado.congeladoHasta = ahora + duracion;
                } else {
                    aliado.lentoHasta = ahora + duracion;
                }

                aliado.inmuneHasta = ahora + duracion + INMUNIDAD_MS;
                sala.sucio = true;

                io.to(aliado.id).emit("efecto", { tipo: trampa.tipo, duracion });
                io.to(codigo).emit("trampaActivada", {
                    id: trampa.id,
                    tipo: trampa.tipo,
                    x: trampa.x,
                    y: trampa.y
                });

                return false; // la trampa se consume
            }
        }

        return true;
    });

    if (sala.trampas.length !== antes) enviarTrampas(codigo);

    // 3) Meta
    for (const aliado of aliados) {
        if (!aliado.muerto && !aliado.llego && aliado.x >= META_X) {
            aliado.llego = true;
            sala.sucio = true;
            io.to(codigo).emit("aliadoLlego", { id: aliado.id });
        }
    }

    // 4) Estado visual (congelado/lento) cambió -> hay que avisar a todos.
    for (const j of jugadores) {
        const estado = `${(j.congeladoHasta || 0) > ahora}|${(j.lentoHasta || 0) > ahora}`;
        if (estado !== j.estadoVisual) {
            j.estadoVisual = estado;
            sala.sucio = true;
        }
    }

    // 5) Condiciones de victoria
    const vivos = aliados.filter(a => !a.muerto);

    if (vivos.length > 0 && vivos.every(a => a.llego)) {
        terminarPartida(codigo, sala, "aliadosGanan", { llegaron: vivos.length });
        return;
    }

    if (vivos.length === 0) {
        terminarPartida(codigo, sala, "enemigoGana", { motivo: "eliminados" });
        return;
    }

    const restante = Math.max(0, Math.ceil((sala.finPartida - ahora) / 1000));

    if (restante !== sala.ultimoTiempoEnviado) {
        sala.ultimoTiempoEnviado = restante;
        io.to(codigo).emit("tiempoRestante", restante);
    }

    if (restante <= 0) {
        terminarPartida(codigo, sala, "enemigoGana", { motivo: "tiempo" });
        return;
    }

    // 6) Se manda el estado UNA vez por tick, y solo si cambió algo.
    if (sala.sucio) {
        sala.sucio = false;
        enviarJugadores(codigo);
    }
}

setInterval(() => {
    const ahora = Date.now();

    for (const [codigo, sala] of salas) {
        if (sala.partidaComenzada && !sala.partidaTerminada) {
            actualizarSala(codigo, sala, ahora);
        }
    }
}, TICK_MS);

// ========================================
// CONEXIONES
// ========================================

io.on("connection", socket => {
    console.log("Jugador conectado:", socket.id);

    // ------------------------------------
    // CREAR SALA
    // ------------------------------------

    socket.on("crearSala", () => {
        let codigo;

        do {
            codigo = generarCodigo();
        } while (salas.has(codigo));

        const sala = {
            jugadores: new Map(),
            partidaComenzada: false,
            partidaTerminada: false,
            enCuentaRegresiva: false,
            timerCuenta: null,
            timerReset: null,
            trampas: [],
            cooldownsTrampa: { lenta: 0, hielo: 0 },
            siguienteIdTrampa: 1,
            finPartida: 0,
            ultimoTiempoEnviado: -1,
            sucio: false
        };

        salas.set(codigo, sala);
        socket.join(codigo);
        socket.sala = codigo;

        sala.jugadores.set(socket.id, {
            id: socket.id,
            x: 100,
            y: 250,
            rol: null,
            muerto: false
        });

        socket.emit("salaCreada", {
            codigo,
            jugadores: 1
        });

        enviarJugadores(codigo);
        enviarRoles(codigo);
        console.log(`Sala ${codigo} creada`);
    });

    // ------------------------------------
    // UNIRSE A UNA SALA
    // ------------------------------------

    socket.on("unirseSala", codigoRecibido => {
        const codigo = String(codigoRecibido || "")
            .trim()
            .toUpperCase();

        const sala = obtenerSala(codigo);

        if (!sala) {
            socket.emit("errorSala", "La sala no existe.");
            return;
        }

        if (sala.jugadores.size >= 4) {
            socket.emit("errorSala", "La sala está llena.");
            return;
        }

        if (sala.partidaComenzada || sala.enCuentaRegresiva) {
            socket.emit("errorSala", "La partida ya está por comenzar o comenzó.");
            return;
        }

        socket.join(codigo);
        socket.sala = codigo;

        sala.jugadores.set(socket.id, {
            id: socket.id,
            x: 700,
            y: 250,
            rol: null,
            muerto: false
        });

        socket.emit("salaCreada", {
            codigo,
            jugadores: sala.jugadores.size
        });

        enviarJugadores(codigo);
        enviarRoles(codigo);
    });

    // ------------------------------------
    // ELEGIR ROL
    // ------------------------------------

    socket.on("elegirRol", rol => {
        if (!socket.sala) return;

        const sala = obtenerSala(socket.sala);
        if (!sala) return;

        const jugador = sala.jugadores.get(socket.id);
        if (!jugador) return;

        if (
            sala.partidaComenzada ||
            sala.partidaTerminada ||
            sala.enCuentaRegresiva
        ) {
            return;
        }

        if (rol !== "aliado" && rol !== "enemigo") {
            socket.emit("errorRol", "Ese rol no es válido.");
            return;
        }

        const roles = contarRoles(sala);

        if (rol === "enemigo") {
            const otroEnemigo = [...sala.jugadores.values()].some(
                otro => otro.id !== socket.id && otro.rol === "enemigo"
            );

            if (otroEnemigo) {
                socket.emit("errorRol", "Ya hay un enemigo en esta sala.");
                return;
            }
        }

        if (rol === "aliado") {
            const otrosAliados = [...sala.jugadores.values()].filter(
                otro => otro.id !== socket.id && otro.rol === "aliado"
            ).length;

            if (otrosAliados >= 3) {
                socket.emit("errorRol", "Ya hay 3 aliados.");
                return;
            }
        }

        jugador.rol = rol;
        jugador.muerto = false;

        enviarJugadores(socket.sala);
        enviarRoles(socket.sala);

        iniciarCuentaRegresiva(socket.sala);
    });

    // ------------------------------------
    // MOVER JUGADOR
    // ------------------------------------

    socket.on("moverJugador", posicion => {
        if (!socket.sala || !posicion) return;

        const sala = obtenerSala(socket.sala);
        if (!sala) return;

        if (
            !sala.partidaComenzada ||
            sala.partidaTerminada ||
            sala.enCuentaRegresiva
        ) {
            return;
        }

        const jugador = sala.jugadores.get(socket.id);
        if (!jugador || jugador.muerto) return;

        if (
            typeof posicion.x !== "number" ||
            typeof posicion.y !== "number" ||
            !Number.isFinite(posicion.x) ||
            !Number.isFinite(posicion.y)
        ) {
            return;
        }

        const ahora = Date.now();
        const dt = Math.min(ahora - (jugador.ultimoMov || ahora), MAX_DT_MOVIMIENTO_MS) / 1000;
        jugador.ultimoMov = ahora;

        // Congelado: el servidor ignora el movimiento (el cliente tampoco se mueve).
        if ((jugador.congeladoHasta || 0) > ahora) return;

        let nx = Math.max(20, Math.min(ANCHO_CANCHA - 20, posicion.x));
        let ny = Math.max(20, Math.min(ALTO_CANCHA - 20, posicion.y));

        // Anti-trampa básico: no se puede ir más rápido que la velocidad máxima.
        const base = jugador.rol === "enemigo" ? VEL_ENEMIGO : VEL_ALIADO;
        const maxDist = base * dt * 1.3 + 10;
        const dx = nx - jugador.x;
        const dy = ny - jugador.y;
        const dist = Math.hypot(dx, dy);

        if (dist > maxDist) {
            nx = jugador.x + (dx / dist) * maxDist;
            ny = jugador.y + (dy / dist) * maxDist;
            socket.emit("corregirPosicion", { x: nx, y: ny });
        }

        jugador.x = nx;
        jugador.y = ny;
        sala.sucio = true; // el tick se encarga de enviarlo
    });

    // ------------------------------------
    // PONER TRAMPA (solo el enemigo)
    // ------------------------------------

    socket.on("ponerTrampa", tipo => {
        if (!socket.sala) return;

        const sala = obtenerSala(socket.sala);
        if (!sala || !sala.partidaComenzada || sala.partidaTerminada) return;

        const jugador = sala.jugadores.get(socket.id);
        if (!jugador || jugador.rol !== "enemigo") return;

        const config = TIPOS_TRAMPA[tipo];
        if (!config) return;

        const ahora = Date.now();

        if (ahora < sala.cooldownsTrampa[tipo]) return;

        if (sala.trampas.length >= TRAMPA_MAX) {
            socket.emit("errorTrampa", `Máximo ${TRAMPA_MAX} trampas a la vez.`);
            return;
        }

        if (jugador.x >= META_X - 40) {
            socket.emit("errorTrampa", "No podés poner trampas pegado a la meta.");
            return;
        }

        for (const otro of sala.jugadores.values()) {
            if (
                otro.rol === "aliado" &&
                !otro.muerto &&
                Math.hypot(otro.x - jugador.x, otro.y - jugador.y) < TRAMPA_DISTANCIA_MIN_ALIADO
            ) {
                socket.emit("errorTrampa", "Hay un aliado demasiado cerca.");
                return;
            }
        }

        sala.cooldownsTrampa[tipo] = ahora + config.cooldown;

        sala.trampas.push({
            id: sala.siguienteIdTrampa++,
            tipo,
            x: jugador.x,
            y: jugador.y,
            venceEn: ahora + TRAMPA_VIDA_MS
        });

        enviarTrampas(socket.sala);
        socket.emit("trampaCooldown", { tipo, ms: config.cooldown });
    });

    // ------------------------------------
    // DESCONECTAR
    // ------------------------------------

    socket.on("disconnect", () => {
        const codigo = socket.sala;
        if (!codigo) return;

        const sala = obtenerSala(codigo);
        if (!sala) return;

        sala.jugadores.delete(socket.id);

        if (sala.enCuentaRegresiva) {
            cancelarCuentaRegresiva(codigo);
        }

        if (sala.jugadores.size === 0) {
            if (sala.timerCuenta) clearInterval(sala.timerCuenta);
            if (sala.timerReset) clearTimeout(sala.timerReset);
            salas.delete(codigo);
            return;
        }

        // Si alguien se va durante la partida, se cancela y todos vuelven a elegir rol.
        if (sala.partidaComenzada) {
            io.to(codigo).emit(
                "partidaCancelada",
                "Un jugador se desconectó. La partida se detuvo."
            );
            resetearSala(codigo);
            console.log("Jugador desconectado:", socket.id);
            return;
        }

        enviarJugadores(codigo);
        enviarRoles(codigo);

        console.log("Jugador desconectado:", socket.id);
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor iniciado en el puerto ${PORT}`);
});
