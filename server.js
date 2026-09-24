const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const salas = new Map();

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

io.on("connection", (socket) => {

    console.log("Jugador conectado:", socket.id);

    // CREAR SALA
    socket.on("crearSala", () => {

        let codigo;

        do {
            codigo = generarCodigo();
        } while (salas.has(codigo));

        salas.set(codigo, new Map());

        socket.join(codigo);
        socket.sala = codigo;

        // Crear jugador
        const jugador = {
            id: socket.id,
            x: 200,
            y: 200
        };

        salas.get(codigo).set(socket.id, jugador);

        socket.emit("salaCreada", {
            codigo: codigo,
            jugadores: salas.get(codigo).size
        });

        enviarJugadores(codigo);

        console.log(`Sala ${codigo} creada`);
    });


    // UNIRSE A SALA
    socket.on("unirseSala", (codigoRecibido) => {

        const codigo = String(codigoRecibido)
            .trim()
            .toUpperCase();

        const sala = salas.get(codigo);

        if (!sala) {
            socket.emit("errorSala", "La sala no existe.");
            return;
        }

        if (sala.size >= 4) {
            socket.emit("errorSala", "La sala está llena.");
            return;
        }

        socket.join(codigo);
        socket.sala = codigo;

        // Posición inicial diferente
        const jugador = {
            id: socket.id,
            x: 600,
            y: 200
        };

        sala.set(socket.id, jugador);

        socket.emit("salaCreada", {
            codigo: codigo,
            jugadores: sala.size
        });

        enviarJugadores(codigo);

        console.log(`Jugador ${socket.id} se unió a ${codigo}`);
    });


    // MOVIMIENTO
    socket.on("moverJugador", (posicion) => {

        if (!socket.sala) return;

        const sala = salas.get(socket.sala);

        if (!sala) return;

        const jugador = sala.get(socket.id);

        if (!jugador) return;

        jugador.x = posicion.x;
        jugador.y = posicion.y;

        // Mandar las posiciones a todos los jugadores
        enviarJugadores(socket.sala);
    });


    // DESCONECTARSE
    socket.on("disconnect", () => {

        if (!socket.sala) return;

        const sala = salas.get(socket.sala);

        if (!sala) return;

        sala.delete(socket.id);

        if (sala.size === 0) {
            salas.delete(socket.sala);
        } else {
            enviarJugadores(socket.sala);
        }

        console.log("Jugador desconectado:", socket.id);
    });

});


function enviarJugadores(codigo) {

    const sala = salas.get(codigo);

    if (!sala) return;

    const jugadores = Array.from(sala.values());

    io.to(codigo).emit("actualizarJugadores", jugadores);
}


const PORT = 3000;

server.listen(PORT, () => {
    console.log(`Servidor iniciado en http://localhost:${PORT}`);
});