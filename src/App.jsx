import { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SPOTIFY_CLIENT_ID = "YOUR_SPOTIFY_CLIENT_ID"; // Replace this
const REDIRECT_URI = window.location.origin + "/callback";
const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
].join(" ");

const SERVER_URL = "http://localhost:3001"; // Change to your deployed server URL
const SYNC_INTERVAL_MS = 2000;
const DRIFT_THRESHOLD_MS = 800;

// ─── SPOTIFY OAUTH HELPERS ───────────────────────────────────────────────────
function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 43);
}

async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function redirectToSpotify() {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  localStorage.setItem("pkce_verifier", verifier);

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

async function exchangeCodeForToken(code) {
  const verifier = localStorage.getItem("pkce_verifier");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  return res.json();
}

async function refreshToken(refresh_token) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token,
    }),
  });
  return res.json();
}

// ─── SPOTIFY API HELPERS ─────────────────────────────────────────────────────
async function spotifyFetch(path, token, options = {}) {
  return fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers },
  });
}

async function getPlaybackState(token) {
  const res = await spotifyFetch("/me/player", token);
  if (res.status === 204 || !res.ok) return null;
  return res.json();
}

async function seekTo(token, positionMs) {
  await spotifyFetch(`/me/player/seek?position_ms=${Math.round(positionMs)}`, token, { method: "PUT" });
}

async function setPlay(token, play) {
  await spotifyFetch(`/me/player/${play ? "play" : "pause"}`, token, { method: "PUT" });
}

async function getUserProfile(token) {
  const res = await spotifyFetch("/me", token);
  return res.json();
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem("sp_token") || null);
  const [refreshTok, setRefreshTok] = useState(() => localStorage.getItem("sp_refresh") || null);
  const [user, setUser] = useState(null);
  const [page, setPage] = useState("home"); // home | lobby | room
  const [roomCode, setRoomCode] = useState("");
  const [joinInput, setJoinInput] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [members, setMembers] = useState([]);
  const [playback, setPlayback] = useState(null);
  const [syncStatus, setSyncStatus] = useState("idle"); // idle | synced | drifted
  const [chat, setChat] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [notification, setNotification] = useState("");
  const socketRef = useRef(null);
  const syncIntervalRef = useRef(null);

  const notify = (msg) => {
    setNotification(msg);
    setTimeout(() => setNotification(""), 3000);
  };

  // ── Handle OAuth callback ──
  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (code) {
      exchangeCodeForToken(code).then((data) => {
        if (data.access_token) {
          localStorage.setItem("sp_token", data.access_token);
          localStorage.setItem("sp_refresh", data.refresh_token);
          setToken(data.access_token);
          setRefreshTok(data.refresh_token);
          window.history.replaceState({}, "", "/");
        }
      });
    }
  }, []);

  // ── Load user profile ──
  useEffect(() => {
    if (!token) return;
    getUserProfile(token).then((p) => {
      if (p.id) setUser(p);
    });
  }, [token]);

  // ── Connect socket ──
  useEffect(() => {
    const socket = io(SERVER_URL, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("sync_state", async (state) => {
      if (isHost) return; // host never follows sync
      if (!token) return;
      const networkDelay = (Date.now() - state.sentAt) / 2;
      const correctedPos = state.positionMs + networkDelay + (Date.now() - state.sentAt);

      const local = await getPlaybackState(token);
      if (!local) return;

      const drift = Math.abs(correctedPos - local.progress_ms);
      if (drift > DRIFT_THRESHOLD_MS) {
        await seekTo(token, correctedPos);
        setSyncStatus("synced");
        setTimeout(() => setSyncStatus("idle"), 2000);
      }

      if (state.isPlaying !== local.is_playing) {
        await setPlay(token, state.isPlaying);
      }
    });

    socket.on("promoted_to_host", () => {
      setIsHost(true);
      notify("👑 You're now the host!");
    });

    socket.on("member_joined", ({ name, count }) => {
      setMembers((m) => [...m, name]);
      notify(`🎵 ${name} joined the room`);
    });

    socket.on("member_left", ({ name, count }) => {
      setMembers((m) => m.filter((x) => x !== name));
      notify(`${name} left the room`);
    });

    socket.on("chat_message", (msg) => {
      setChat((c) => [...c.slice(-49), msg]);
    });

    return () => socket.disconnect();
  }, [token, isHost]);

  // ── Host sync loop ──
  const startHostSync = useCallback(() => {
    if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    syncIntervalRef.current = setInterval(async () => {
      if (!token) return;
      const state = await getPlaybackState(token);
      if (!state) return;
      setPlayback(state);
      socketRef.current?.emit("push_state", {
        trackId: state.item?.id,
        trackName: state.item?.name,
        artist: state.item?.artists?.[0]?.name,
        albumArt: state.item?.album?.images?.[0]?.url,
        positionMs: state.progress_ms,
        durationMs: state.item?.duration_ms,
        isPlaying: state.is_playing,
        sentAt: Date.now(),
      });
    }, SYNC_INTERVAL_MS);
  }, [token]);

  // ── Guest poll loop ──
  const startGuestPoll = useCallback(() => {
    if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    syncIntervalRef.current = setInterval(async () => {
      if (!token) return;
      const state = await getPlaybackState(token);
      if (state) setPlayback(state);
      socketRef.current?.emit("request_sync");
    }, SYNC_INTERVAL_MS);
  }, [token]);

  useEffect(() => {
    if (page !== "room") {
      clearInterval(syncIntervalRef.current);
      return;
    }
    if (isHost) startHostSync();
    else startGuestPoll();
    return () => clearInterval(syncIntervalRef.current);
  }, [page, isHost, startHostSync, startGuestPoll]);

  // ── Actions ──
  const createRoom = () => {
    socketRef.current.emit("create_room", { displayName: user?.display_name || "Host" }, (res) => {
      if (res.success) {
        setRoomCode(res.roomCode);
        setIsHost(true);
        setMembers([user?.display_name || "Host"]);
        setPage("room");
      }
    });
  };

  const joinRoom = () => {
    if (!joinInput.trim()) return;
    socketRef.current.emit("join_room", { roomCode: joinInput, displayName: user?.display_name || "Guest" }, (res) => {
      if (res.success) {
        setRoomCode(res.roomCode);
        setIsHost(false);
        setMembers(res.members || []);
        setPage("room");
      } else {
        notify("❌ " + res.error);
      }
    });
  };

  const sendChat = () => {
    if (!chatInput.trim()) return;
    socketRef.current.emit("chat_message", { text: chatInput });
    setChatInput("");
  };

  const leaveRoom = () => {
    clearInterval(syncIntervalRef.current);
    socketRef.current.disconnect();
    socketRef.current.connect();
    setPage("home");
    setRoomCode("");
    setIsHost(false);
    setMembers([]);
    setChat([]);
    setPlayback(null);
  };

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <div className="app">
      {notification && <div className="toast">{notification}</div>}

      {!token && (
        <div className="screen center">
          <div className="logo">◎ SyncRoom</div>
          <p className="tagline">Listen together, in perfect sync.</p>
          <button className="btn-green" onClick={redirectToSpotify}>
            Connect Spotify
          </button>
        </div>
      )}

      {token && page === "home" && (
        <div className="screen center">
          <div className="logo">◎ SyncRoom</div>
          {user && <div className="user-badge">👤 {user.display_name}</div>}
          <div className="card">
            <button className="btn-green" onClick={createRoom}>
              🎵 Create Room
            </button>
            <div className="divider">or</div>
            <div className="join-row">
              <input
                className="input"
                placeholder="Room code (e.g. ABC123)"
                value={joinInput}
                onChange={(e) => setJoinInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && joinRoom()}
                maxLength={6}
              />
              <button className="btn-white" onClick={joinRoom}>Join</button>
            </div>
          </div>
        </div>
      )}

      {token && page === "room" && (
        <div className="screen room">
          <header className="room-header">
            <div className="room-code">
              Room: <strong>{roomCode}</strong>
              <span className="copy-btn" onClick={() => { navigator.clipboard.writeText(roomCode); notify("Copied!"); }}>📋</span>
            </div>
            <div className="badge">{isHost ? "👑 Host" : "🎧 Guest"}</div>
            <button className="btn-leave" onClick={leaveRoom}>Leave</button>
          </header>

          <div className="room-body">
            {/* Now Playing */}
            <div className="now-playing">
              {playback?.item ? (
                <>
                  <img className="album-art" src={playback.item.album?.images?.[0]?.url} alt="album" />
                  <div className="track-info">
                    <div className="track-name">{playback.item.name}</div>
                    <div className="track-artist">{playback.item.artists?.[0]?.name}</div>
                    <div className="progress-bar">
                      <div
                        className="progress-fill"
                        style={{ width: `${(playback.progress_ms / playback.item.duration_ms) * 100}%` }}
                      />
                    </div>
                    <div className="sync-status">
                      {isHost ? "🎙 Broadcasting" : syncStatus === "synced" ? "✅ Synced" : "🔄 Listening"}
                    </div>
                  </div>
                </>
              ) : (
                <div className="no-track">
                  {isHost ? "▶ Start playing something on Spotify!" : "⏳ Waiting for host to play..."}
                </div>
              )}
            </div>

            {/* Members */}
            <div className="members">
              <div className="section-title">Listeners ({members.length})</div>
              <div className="member-list">
                {members.map((m, i) => (
                  <div key={i} className="member-chip">{m}</div>
                ))}
              </div>
            </div>

            {/* Chat */}
            <div className="chat-panel">
              <div className="section-title">Chat</div>
              <div className="chat-messages">
                {chat.map((m, i) => (
                  <div key={i} className="chat-msg">
                    <span className="chat-name">{m.name}</span> {m.text}
                  </div>
                ))}
              </div>
              <div className="chat-input-row">
                <input
                  className="input"
                  placeholder="Say something..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendChat()}
                />
                <button className="btn-white" onClick={sendChat}>Send</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
