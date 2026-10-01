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
// GENERAR CÓDIGO
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
// ENVIAR JUGADORES
// ===============================

function enviarJugadores(codigo) {

    const sala = salas.get(codigo);

    if (!sala) return;

    const jugadores =
        Array.from(sala.values());

    io.to(codigo).emit(
        "actualizarJugadores",
        jugadores
    );
}


// ===============================
// ACTUALIZAR ROLES
// ===============================

function enviarRoles(codigo) {

    const sala = salas.get(codigo);

    if (!sala) return;

    let aliados = 0;
    let enemigo = false;

    for (const jugador of sala.values()) {

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

    if (sala.size !== 4) {
        return false;
    }

    let aliados = 0;
    let enemigos = 0;

    for (const jugador of sala.values()) {

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
            new Map()
        );


        socket.join(codigo);

        socket.sala = codigo;


        const jugador = {

            id: socket.id,

            x: 200,

            y: 200,

            rol: null,

            muerto: false

        };


        salas
            .get(codigo)
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


            if (sala.size >= 4) {

                socket.emit(
                    "errorSala",
                    "La sala está llena."
                );

                return;

            }


            socket.join(codigo);

            socket.sala = codigo;


            const jugador = {

                id: socket.id,

                x: 600,

                y: 200,

                rol: null,

                muerto: false

            };


            sala.set(
                socket.id,
                jugador
            );


            socket.emit(
                "salaCreada",
                {
                    codigo: codigo,
                    jugadores: sala.size
                }
            );


            enviarJugadores(codigo);

            enviarRoles(codigo);


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
                sala.get(socket.id);


            if (!jugador) return;


            // No permitir cambiar
            // si ya empezó la partida

            if (
                partidaLista(socket.sala)
            ) {

                return;

            }


            // =========================
            // ENEMIGO
            // =========================

            if (rol === "enemigo") {

                for (
                    const otro of sala.values()
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
                    const otro of sala.values()
                ) {

                    if (
                        otro.rol === "aliado" &&
                        otro.id !== socket.id
                    ) {

                        cantidadAliados++;

                    }

                }


                if (
                    cantidadAliados >= 3
                ) {

                    socket.emit(
                        "errorRol",
                        "Ya hay 3 aliados."
                    );

                    return;

                }

            }


            jugador.rol = rol;


            enviarJugadores(
                socket.sala
            );


            enviarRoles(
                socket.sala
            );


            // Si están los 4 y
            // los roles son correctos,
            // iniciar partida

            if (
                partidaLista(socket.sala)
            ) {

                for (
                    const jugadorSala
                    of sala.values()
                ) {

                    jugadorSala.muerto = false;

                }


                io.to(socket.sala).emit(
                    "partidaIniciada"
                );


                enviarJugadores(
                    socket.sala
                );

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
                sala.get(socket.id);


            if (!jugador) return;


            // Un muerto no puede moverse

            if (jugador.muerto) {
                return;
            }


            // Solo aceptar números

            if (
                typeof posicion.x !== "number" ||
                typeof posicion.y !== "number"
            ) {

                return;

            }


            jugador.x = Math.max(
                20,
                Math.min(
                    780,
                    posicion.x
                )
            );


            jugador.y = Math.max(
                20,
                Math.min(
                    480,
                    posicion.y
                )
            );


            // =========================
            // DETECTAR CONTACTOS
            // =========================

            if (
                jugador.rol === "enemigo"
            ) {

                for (
                    const otro
                    of sala.values()
                ) {

                    if (
                        otro.rol !== "aliado"
                    ) {
                        continue;
                    }


                    if (otro.muerto) {
                        continue;
                    }


                    const dx =
                        jugador.x - otro.x;


                    const dy =
                        jugador.y - otro.y;


                    const distancia =
                        Math.sqrt(
                            dx * dx +
                            dy * dy
                        );


                    // 40 + 40 aproximadamente

                    if (
                        distancia < 40
                    ) {

                        otro.muerto = true;


                        io.to(
                            socket.sala
                        ).emit(
                            "aliadoMuerto",
                            {
                                id: otro.id
                            }
                        );


                        console.log(
                            `El enemigo ${jugador.id} eliminó a ${otro.id}`
                        );

                    }

                }


                // =========================
                // COMPROBAR VICTORIA
                // =========================

                let muertos = 0;


                for (
                    const otro
                    of sala.values()
                ) {

                    if (
                        otro.rol === "aliado" &&
                        otro.muerto
                    ) {

                        muertos++;

                    }

                }


                if (muertos >= 3) {

                    io.to(
                        socket.sala
                    ).emit(
                        "enemigoGana"
                    );

                }

            }


            enviarJugadores(
                socket.sala
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


            sala.delete(
                socket.id
            );


            if (sala.size === 0) {

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

            }


            console.log(
                "Jugador desconectado:",
                socket.id
            );

        }
    );

});


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
