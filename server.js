require('dotenv').config(); // Loads environment variables
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

let waitingUser = null; 
const reportCounts = {}; 
const bans = {}; 
let onlineUsers = 0; 

// --- SECURE ADMIN SYSTEM ---
let adminSocketId = null;
const activeUsers = new Map();

function broadcastAdminUpdate() {
  if (adminSocketId) {
    const usersArray = Array.from(activeUsers.values());
    io.to(adminSocketId).emit('admin_users_update', usersArray);
  }
}

io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('online_count', onlineUsers);

  const userIp = socket.handshake.address;

  // Track User for Admin Dashboard
  activeUsers.set(socket.id, { id: socket.id, ip: userIp, name: 'Anonymous', room: null, device: 'Mobile/Web' });
  broadcastAdminUpdate();

  // Check if banned
  if (bans[userIp] && bans[userIp] > Date.now()) {
    socket.emit('banned', { message: 'You are banned from Vartalap.' });
    socket.disconnect();
    return;
  }

  // --- ADMIN AUTH & COMMANDS ---
  socket.on('admin_auth', (pass) => {
    // Password is now securely fetched from Render Environment Variables
    const TRUE_PASSWORD = process.env.ADMIN_PASSWORD;
    
    if (!TRUE_PASSWORD) {
       socket.emit('admin_auth_fail', "Admin Password not set in Render Settings!");
       return;
    }
    
    if (pass === TRUE_PASSWORD) {
      adminSocketId = socket.id;
      socket.emit('admin_auth_success');
      broadcastAdminUpdate();
    } else {
      socket.emit('admin_auth_fail', "Wrong Password");
    }
  });

  // Admin Kick/Ban commands (Compatible with your old meet.html)
  socket.on('admin_command', ({ targetId, action }) => {
    if (socket.id !== adminSocketId) return;
    
    if (action === 'kick') {
        const target = io.sockets.sockets.get(targetId);
        if (target) {
            // Your old meet.html already knows how to handle the 'banned' event
            target.emit('banned', { message: 'You have been kicked by the Master.' });
            target.disconnect();
        }
    }
  });

  socket.on('admin_ban', (targetIp) => {
    if (socket.id !== adminSocketId) return;
    bans[targetIp] = Date.now() + (60000 * 60 * 24); // 24 hours ban
    io.sockets.sockets.forEach((s) => {
      if (s.handshake.address === targetIp) {
        s.emit('banned', { message: 'You have been permanently banned.' });
        s.disconnect();
      }
    });
    broadcastAdminUpdate();
  });
  // -----------------------------

  // Core Matchmaking (Untouched, works perfectly with old meet.html)
  socket.on('find_match', (userData) => {
    const u = activeUsers.get(socket.id);
    if (u) { 
        u.name = userData?.name || 'Anonymous'; 
        activeUsers.set(socket.id, u); 
    }

    if (waitingUser && waitingUser.id !== socket.id) {
      const partner = waitingUser;
      waitingUser = null;

      const roomId = `room_${socket.id}_${partner.id}`;
      socket.join(roomId); partner.join(roomId);
      socket.roomId = roomId; partner.roomId = roomId;

      const u1 = activeUsers.get(socket.id); if(u1) u1.room = roomId;
      const u2 = activeUsers.get(partner.id); if(u2) u2.room = roomId;
      broadcastAdminUpdate();

      io.to(socket.id).emit('match_found', { initiator: true, partnerName: partner.userData?.name || 'Stranger' });
      io.to(partner.id).emit('match_found', { initiator: false, partnerName: userData?.name || 'Stranger' });
    } else {
      socket.userData = userData;
      waitingUser = socket;
      broadcastAdminUpdate();
    }
  });

  // WebRTC
  socket.on('offer', (data) => socket.to(socket.roomId).emit('offer', data));
  socket.on('answer', (data) => socket.to(socket.roomId).emit('answer', data));
  socket.on('ice_candidate', (data) => socket.to(socket.roomId).emit('ice_candidate', data));
  
  // Chat & Reactions with Admin Spy
  socket.on('send_message', (message) => {
    socket.to(socket.roomId).emit('receive_message', message);
    
    // Send copy to Admin Dashboard
    if (adminSocketId) {
      const u = activeUsers.get(socket.id);
      io.to(adminSocketId).emit('admin_chat_spy', { room: socket.roomId, msg: message, from: u ? u.name : 'Unknown' });
    }
  });
  
  socket.on('send_reaction', (emoji) => socket.to(socket.roomId).emit('receive_reaction', emoji));

  // Report System
  socket.on('report_user', () => {
    const room = io.sockets.adapter.rooms.get(socket.roomId);
    if (room) {
      for (const clientId of room) {
        if (clientId !== socket.id) {
          const partnerSocket = io.sockets.sockets.get(clientId);
          const partnerIp = partnerSocket.handshake.address;
          
          reportCounts[partnerIp] = (reportCounts[partnerIp] || 0) + 1;
          if (reportCounts[partnerIp] >= 3) {
            bans[partnerIp] = Date.now() + 60000; 
            reportCounts[partnerIp] = 0; 
            partnerSocket.emit('banned', { message: 'Banned for 1 min due to reports.' });
            partnerSocket.disconnect();
          }
          break;
        }
      }
    }
  });

  // Disconnects & Cleanup
  socket.on('leave_match', () => {
    socket.to(socket.roomId).emit('partner_left');
    socket.leave(socket.roomId);
    const u = activeUsers.get(socket.id);
    if(u) { u.room = null; activeUsers.set(socket.id, u); }
    broadcastAdminUpdate();
    socket.roomId = null;
  });

  socket.on('disconnect', () => {
    onlineUsers--;
    io.emit('online_count', onlineUsers);
    
    activeUsers.delete(socket.id);
    if (socket.id === adminSocketId) adminSocketId = null;
    if (waitingUser && waitingUser.id === socket.id) waitingUser = null;
    if (socket.roomId) socket.to(socket.roomId).emit('partner_left');
    
    broadcastAdminUpdate();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Vartalap running on port ${PORT}`));
