
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

function enviarJugadores(codigo) {
    const sala = obtenerSala(codigo);
    if (!sala) return;

    io.to(codigo).emit(
        "actualizarJugadores",
        Array.from(sala.jugadores.values())
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

        for (const jugador of sala.jugadores.values()) {
            jugador.muerto = false;

            if (jugador.rol === "aliado") {
                const posicion = posicionesAliados[indiceAliado++];
                jugador.x = posicion.x;
                jugador.y = posicion.y;
            } else {
                // El enemigo empieza bien lejos de los aliados.
                jugador.x = 700;
                jugador.y = 250;
            }
        }

        io.to(codigo).emit("partidaIniciada", {
            ancho: ANCHO_CANCHA,
            alto: ALTO_CANCHA
        });

        enviarJugadores(codigo);
        console.log(`Partida iniciada en sala ${codigo}`);
    }, 1000);
}

// ========================================
// MOVIMIENTO Y CONTACTOS
// ========================================

function comprobarContactos(codigo, sala, jugador) {
    if (jugador.rol !== "enemigo" || jugador.muerto) return;

    for (const otro of sala.jugadores.values()) {
        if (otro.rol !== "aliado" || otro.muerto) continue;

        const dx = jugador.x - otro.x;
        const dy = jugador.y - otro.y;
        const distancia = Math.sqrt(dx * dx + dy * dy);

        if (distancia < RADIO_CONTACTO) {
            otro.muerto = true;

            io.to(codigo).emit("aliadoMuerto", {
                id: otro.id
            });

            console.log(`El enemigo eliminó al aliado ${otro.id}`);
        }
    }

    let aliadosVivos = 0;

    for (const otro of sala.jugadores.values()) {
        if (otro.rol === "aliado" && !otro.muerto) {
            aliadosVivos++;
        }
    }

    if (aliadosVivos === 0 && !sala.partidaTerminada) {
        sala.partidaTerminada = true;
        sala.partidaComenzada = false;
        io.to(codigo).emit("enemigoGana");
    }
}

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
            timerCuenta: null
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

        jugador.x = Math.max(
            20,
            Math.min(ANCHO_CANCHA - 20, posicion.x)
        );

        jugador.y = Math.max(
            20,
            Math.min(ALTO_CANCHA - 20, posicion.y)
        );

        comprobarContactos(socket.sala, sala, jugador);
        enviarJugadores(socket.sala);
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
            salas.delete(codigo);
            return;
        }

        // Si alguien se va durante la partida, se detiene.
        if (sala.partidaComenzada) {
            sala.partidaComenzada = false;
            sala.partidaTerminada = false;
            io.to(codigo).emit(
                "partidaCancelada",
                "Un jugador se desconectó. La partida se detuvo."
            );
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
