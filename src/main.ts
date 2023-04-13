import "./style.css";

const PORT = 3000;

// const uname = Deno.args[0] !== "-2" ? "user_1" : "user_2";
// const uname = "user_1";
const uname = (location.search ?? "?user_1").substring(1);

type RtcSocketClientMessage = {
    ty: "IceCandidate",
    target: string,
    candidate: RTCIceCandidateInit,
} | {
    ty: "Offer",
    target: string,
    offer: RTCSessionDescriptionInit,
} | {
    ty: "Answer",
    target: string,
    answer: RTCSessionDescriptionInit,
} | {
    ty: "Init",
    target: string,
    name: string,
};

type RtcSocketMessage = {
    ty: "JoinSelf",
    id: string,
} | {
    ty: "Join",
    id: string,
    username: string,
} | (Exclude<RtcSocketClientMessage, "target"> & { source: string });


const ICE_SERVERS = [
    {
        urls: [
            "stun:stun.l.google.com:19302",
            "stun:stun1.l.google.com:19302",
            // "stun:stun2.l.google.com:19302",
            // "stun:stun3.l.google.com:19302",
            // "stun:stun4.l.google.com:19302",
        ],
    },
];

type DataChannelDesc = Record<string, number>;

type Connection<C> = {
    conn: RTCPeerConnection,
    name: string,
    channels: Record<keyof C, RTCDataChannel>,
    connected: boolean,
};

class RtcManager<C extends DataChannelDesc> {
    private _connected: boolean;
    private _sock: WebSocket;

    private _chan_desc: C;
    private _own_id?: string;
    private _connections: Map<string, Connection<C>> = new Map();

    public onconnection: (conn: Connection<C>) => void = () => {};
    public onconnectionend: (conn: Connection<C>) => void = () => {};

    public constructor(sock: WebSocket, chan_desc: C) {
        if(sock.readyState === sock.CLOSING || sock.readyState === sock.CLOSED) {
            throw new Error("RtcManager received already closed WebSocket");
        }

        this._connected = sock.readyState === sock.OPEN;
        this._sock = sock;
        this._chan_desc = chan_desc;

        if(!this._connected) {
            sock.addEventListener("open", _ => {
                this._connected = true;
                this._init_connection();
            });
        } else {
            this._init_connection();
        }
    }

    private _init_connection() {
        console.log("initialising connections");
        if(!this._connected || this._sock.readyState !== this._sock.OPEN) {
            throw new Error("tried to call _init_connection without connected WebSocket");
        }

        this._sock.addEventListener("message", ev => {
            if(typeof ev.data === "string") {
                const msg = JSON.parse(ev.data) as RtcSocketMessage;

                switch(msg.ty) {
                    case "JoinSelf": {
                        this._own_id = msg.id;
                    } break;
                    case "Join": {
                        this._handle_join(msg.id, msg.username);
                    } break;
                    case "Init": {
                        this._init_conn(msg.source, msg.name);
                    } break;
                    case "IceCandidate": {
                        this._handle_ice(msg.source, msg.candidate);
                    } break;
                    case "Offer": {
                        this._handle_offer(msg.source, msg.offer);
                    } break;
                    case "Answer": {
                        this._handle_answer(msg.source, msg.answer);
                    } break;

                    default: console.warn("unknown socket message: ", msg); break;
                }
            } else { console.warn("got unexpected binary message") }
        });
    }

    private _get_conn(id: string) {
        let conn = this._connections.get(id);
        if(!conn) throw new Error(`could not get connection: invalid id: ${id}`);
        return conn.conn;
    }

    private _handle_join(id: string, name: string) {
        const conn = this._init_conn(id, name);
        this._sock.send(JSON.stringify({
            ty: "Init",
            target: id,
            name: "temp_name"
        } as RtcSocketClientMessage));

        conn.addEventListener("icecandidate", ev => {
            // console.log("candidate", ev.candidate);
            if(ev.candidate) {
                this._sock.send(JSON.stringify({
                    ty: "IceCandidate",
                    target: id,
                    candidate: ev.candidate?.toJSON(),
                } as RtcSocketClientMessage));
            }
        });
        this._create_offer(id);
    }

    private _init_conn(id: string, name: string) {
        console.log("initializing conn (_init_conn)");
        const conn = new RTCPeerConnection({
            iceServers: ICE_SERVERS,
        });

        const channels = this._init_data_channels(conn);
        const connected = false;
        const c = { conn, name, channels, connected };
        this._connections.set(id, c);
        const handler = () => {
            if(conn.connectionState === "connected") {
                c.connected = true;
                this.onconnection(c);
            } else if(["disconnected", "closed", "failed"].includes(conn.connectionState)) {
                this._connections.delete(id);
                this.onconnectionend(c);
                conn.removeEventListener("connectionstatechange", handler);
            }
        };
        conn.addEventListener("connectionstatechange", handler);
        return conn;
    }

    private _handle_ice(id: string, candidateJson: RTCIceCandidateInit) {
        const candidate = new RTCIceCandidate(candidateJson);
        this._connections.get(id)?.conn.addIceCandidate(candidate);
    }

    private async _handle_offer(id: string, descr: RTCSessionDescriptionInit) {
        const conn = this._get_conn(id);

        await conn?.setRemoteDescription(descr);
        await this._create_answer(conn, id);
    }

    private async _handle_answer(id: string, descr: RTCSessionDescriptionInit) {
        const conn = this._get_conn(id);
        await conn.setRemoteDescription(descr);
    }

    private async _create_offer(id: string) {
        const conn = this._get_conn(id);
        let offer = await conn.createOffer();
        await conn.setLocalDescription(offer);
        this._sock.send(JSON.stringify({
            ty: "Offer",
            offer,
            target: id,
        } as RtcSocketClientMessage));
    }

    private async _create_answer(conn: RTCPeerConnection, id: string) {
        const answer = await conn.createAnswer();
        await conn.setLocalDescription(answer);

        this._sock.send(JSON.stringify({
            ty: "Answer",
            target: id,
            answer: answer,
        } as RtcSocketClientMessage));
    }

    private _init_data_channels(conn: RTCPeerConnection) {
        console.log("init connections");
        const data_channels: Record<keyof C, RTCDataChannel> = {} as any;
        for(const k in this._chan_desc) {
            let id = this._chan_desc[k];
            let chan = conn.createDataChannel(k, { negotiated: true, id });
            data_channels[k] = chan;
        }
        return data_channels;
    }

    public get_user(id: string): Promise<Connection<C>> {
        let conn = this._connections.get(id);
        if(!conn) throw new Error("tried to retrieve invalid connection");

        if(conn.conn.connectionState === "connected") { return Promise.resolve(conn) }
        return new Promise(res => {
            let handler = () => {
                if(conn!.conn.connectionState === "connected") {
                    conn!.conn.removeEventListener("connectionstatechange", handler);
                    res(conn!);
                }
            };
            conn!.conn.addEventListener("connectionstatechange", handler);
        });
    }

    public get_connections() {
        let res = [];
        for(const conn of this._connections.values()) {
            if(conn.connected) res.push(conn);
        }
        return res;
    }
}

const sock = new WebSocket(`ws://localhost:${PORT}/ws/test_room/${uname}`);
console.log(`connecting as ${uname}`);

let manager = new RtcManager(sock, { "test": 1 } as const);

manager.onconnection = (conn) => {
    console.log(conn.conn.connectionState, "connected");
    conn.channels.test.addEventListener("message", ev => {
        console.log("channel message:", ev.data);
    });
    conn.channels.test.addEventListener("open", () => {
        console.log("channel open");
        conn.channels.test.send(`message from conn ${conn.name}`);
    });
};

manager.onconnectionend = (conn) => {
    console.log("disconnected: ", conn);
};

sock.addEventListener("close", _ => console.log("closing socket"));
sock.addEventListener("error", ev => console.error("socket error", ev));

