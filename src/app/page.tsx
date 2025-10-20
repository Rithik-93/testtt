"use client";
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const WS_PATH = "/socket.io/";

const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: [
        "turn:146.190.10.192:3478",
        "turn:146.190.10.192:3478?transport=tcp"
      ],
      username: "lakeside",
      credential: "lakeside-turn-2025-secure-password",
    },
  ],
  iceCandidatePoolSize: 10,
  // iceTransportPolicy: "relay", // uncomment to force TURN only
};

export default function Home() {
  const [room, setRoom] = useState("");
  const [connected, setConnected] = useState(false);
  const [inRoom, setInRoom] = useState(false);
  const [mounted, setMounted] = useState(false);

  const socketRef = useRef<any>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const roomRef = useRef<string>("");
  const iceCandidateQueueRef = useRef<any[]>([]);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const ensureSocket = () => {
    if (!socketRef.current) {
      // Use the current origin in production, or localhost in development
      const socketUrl = typeof window !== 'undefined' 
        ? (window.location.hostname === 'localhost' ? 'http://localhost:3000' : window.location.origin)
        : 'http://localhost:3000';
      
      console.log('Creating socket connection to', socketUrl);
      socketRef.current = io(socketUrl, { 
        transports: ["polling", "websocket"],
        autoConnect: true
      });
      
      socketRef.current.on("connect", () => {
        console.log('Socket connected!');
        setConnected(true);
      });
      
      socketRef.current.on("disconnect", (reason: any) => {
        console.log('Socket disconnected:', reason);
        setConnected(false);
      });
      
      socketRef.current.on("connect_error", (error: any) => {
        console.error('Socket connection error:', error);
      });

      socketRef.current.on("signal", async (data: any) => {
        console.log('Received signal:', data.type || 'candidate');
        if (!pcRef.current) {
          console.log('No peer connection, ignoring signal');
          return;
        }
        
        if (data.type === "offer") {
          console.log('Handling offer');
          await pcRef.current.setRemoteDescription(data);
          const answer = await pcRef.current.createAnswer();
          await pcRef.current.setLocalDescription(answer);
          console.log('Sending answer to room:', roomRef.current);
          socketRef.current.emit("signal", { room: roomRef.current, data: answer });
          
          // Process queued ICE candidates
          console.log(`Processing ${iceCandidateQueueRef.current.length} queued candidates`);
          while (iceCandidateQueueRef.current.length > 0) {
            const candidate = iceCandidateQueueRef.current.shift();
            try {
              await pcRef.current.addIceCandidate(candidate);
            } catch (e) {
              console.error("Failed to add queued ICE candidate:", e);
            }
          }
        } else if (data.type === "answer") {
          console.log('Handling answer');
          await pcRef.current.setRemoteDescription(data);
          
          // Process queued ICE candidates
          console.log(`Processing ${iceCandidateQueueRef.current.length} queued candidates`);
          while (iceCandidateQueueRef.current.length > 0) {
            const candidate = iceCandidateQueueRef.current.shift();
            try {
              await pcRef.current.addIceCandidate(candidate);
            } catch (e) {
              console.error("Failed to add queued ICE candidate:", e);
            }
          }
        } else if (data.candidate) {
          console.log('Handling ICE candidate');
          if (pcRef.current.remoteDescription) {
            try {
              await pcRef.current.addIceCandidate(data);
            } catch (e) {
              console.error("Failed to add ICE candidate:", e);
            }
          } else {
            console.warn('Remote description not set yet, queueing candidate');
            iceCandidateQueueRef.current.push(data);
          }
        }
      });
    }
  };

  const joinRoom = async () => {
    if (!room.trim()) return;
    roomRef.current = room;
    ensureSocket();
    console.log('Joining room:', room);
    socketRef.current.emit("join", room);
    setInRoom(true);

    if (!localStreamRef.current) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    }

    if (!pcRef.current) {
      const pc = new RTCPeerConnection(rtcConfig);
      localStreamRef.current!.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current!));
      pc.ontrack = (evt) => {
        console.log('Remote track received');
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = evt.streams[0];
      };
      pc.onicecandidate = (evt) => {
        if (evt.candidate) {
          const candidateStr = evt.candidate.candidate;
          let candidateType = 'unknown';
          if (candidateStr.includes('typ host')) candidateType = 'host';
          else if (candidateStr.includes('typ srflx')) candidateType = 'srflx (STUN)';
          else if (candidateStr.includes('typ relay')) candidateType = 'relay (TURN)';
          
          console.log(`🟢 Sending ICE candidate [${candidateType}] to room:`, roomRef.current);
          console.log('   Candidate:', candidateStr);
          socketRef.current.emit("signal", {
            room: roomRef.current,
            data: {
              candidate: evt.candidate.candidate,
              sdpMid: evt.candidate.sdpMid,
              sdpMLineIndex: evt.candidate.sdpMLineIndex,
            },
          });
        }
      };
      pc.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', pc.iceConnectionState);
      };
      pc.onconnectionstatechange = () => {
        console.log('Connection state:', pc.connectionState);
      };
      pcRef.current = pc;
    }
  };

  const startCall = async () => {
    if (!pcRef.current) return;
    console.log('Creating offer for room:', roomRef.current);
    const offer = await pcRef.current.createOffer();
    await pcRef.current.setLocalDescription(offer);
    socketRef.current.emit("signal", { room: roomRef.current, data: offer });
  };

  const hangup = () => {
    if (pcRef.current) {
      pcRef.current.getSenders()?.forEach((s) => s.track?.stop());
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setInRoom(false);
  };

  if (!mounted) {
    return (
      <div style={{ fontFamily: "system-ui", padding: 16 }}>
        <h1>WebRTC Minimal Test</h1>
        <div>Loading...</div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 16 }}>
      <h1>WebRTC Minimal Test</h1>
      <div>Socket: {connected ? "connected" : "disconnected"}</div>
      <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <button onClick={ensureSocket} disabled={connected}>
          {connected ? "Connected" : "Connect Socket"}
        </button>
        <input
          placeholder="Room ID"
          value={room}
          onChange={(e) => setRoom(e.target.value)}
          style={{ padding: 8 }}
        />
        <button disabled={!connected || inRoom} onClick={joinRoom}>Join Room</button>
        <button disabled={!inRoom} onClick={startCall}>Start Call</button>
        <button disabled={!inRoom} onClick={hangup}>Hangup</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <h3>Local</h3>
          <video ref={localVideoRef} autoPlay muted playsInline style={{ width: "100%", background: "#222" }} />
        </div>
        <div>
          <h3>Remote</h3>
          <video ref={remoteVideoRef} autoPlay playsInline style={{ width: "100%", background: "#222" }} />
        </div>
      </div>
    </div>
  );
}
