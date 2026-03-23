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
let onlineUsers = 0; // Track real online users

// --- ADMIN SYSTEM VARIABLES ---
let adminSocketId = null;
const ADMIN_PASSWORD = "anurag13931j"; 
const activeUsers = new Map(); // Tracks all users for the admin dashboard

function broadcastAdminUpdate() {
  if (adminSocketId) {
    const usersArray = Array.from(activeUsers.values());
    io.to(adminSocketId).emit('admin_users_update', usersArray);
  }
}
// ------------------------------

io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('online_count', onlineUsers); // Broadcast count to everyone

  const userIp = socket.handshake.address;

  // Register user for admin panel
  activeUsers.set(socket.id, { id: socket.id, ip: userIp, name: 'Anonymous', room: null });
  broadcastAdminUpdate();

  if (bans[userIp] && bans[userIp] > Date.now()) {
    socket.emit('banned', { message: 'You are banned for 1 minute or kicked by Admin.' });
    socket.disconnect();
    return;
  }

  // --- ADMIN AUTH & COMMANDS ---
  socket.on('admin_auth', (pass) => {
    if (pass === ADMIN_PASSWORD) {
      adminSocketId = socket.id;
      socket.emit('admin_auth_success');
      broadcastAdminUpdate(); // Send initial data
    } else {
      socket.emit('admin_auth_fail');
    }
  });

  socket.on('admin_kick', (targetId) => {
    if (socket.id !== adminSocketId) return;
    const target = io.sockets.sockets.get(targetId);
    if (target) {
      target.emit('banned', { message: 'You have been kicked by the Master.' });
      target.disconnect();
    }
  });

  socket.on('admin_ban', (targetIp) => {
    if (socket.id !== adminSocketId) return;
    bans[targetIp] = Date.now() + (60000 * 60 * 24); // Ban for 24 hours
    // Disconnect everyone matching this IP immediately
    io.sockets.sockets.forEach((s) => {
      if (s.handshake.address === targetIp) {
        s.emit('banned', { message: 'You have been permanently banned by Admin.' });
        s.disconnect();
      }
    });
    broadcastAdminUpdate();
  });
  // -----------------------------

  socket.on('find_match', (userData) => {
    // Update admin tracking info with actual name
    const u = activeUsers.get(socket.id);
    if (u) { u.name = userData?.name || 'Anonymous'; activeUsers.set(socket.id, u); }

    if (waitingUser && waitingUser.id !== socket.id) {
      const partner = waitingUser;
      waitingUser = null;

      const roomId = `room_${socket.id}_${partner.id}`;
      socket.join(roomId);
      partner.join(roomId);
      socket.roomId = roomId;
      partner.roomId = roomId;

      // Update room info for admin
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

  // WebRTC Signaling
  socket.on('offer', (data) => socket.to(socket.roomId).emit('offer', data));
  socket.on('answer', (data) => socket.to(socket.roomId).emit('answer', data));
  socket.on('ice_candidate', (data) => socket.to(socket.roomId).emit('ice_candidate', data));
  
  // Pass chat and reactions between peers AND to Admin
  socket.on('send_message', (message) => {
    socket.to(socket.roomId).emit('receive_message', message);
    
    // Send a secret copy to the Admin panel
    if (adminSocketId) {
      const u = activeUsers.get(socket.id);
      const senderName = u ? u.name : 'Unknown';
      io.to(adminSocketId).emit('admin_chat_spy', { room: socket.roomId, msg: message, from: senderName });
    }
  });
  
  socket.on('send_reaction', (emoji) => socket.to(socket.roomId).emit('receive_reaction', emoji));

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

  socket.on('leave_match', () => {
    socket.to(socket.roomId).emit('partner_left');
    socket.leave(socket.roomId);
    
    // Reset room info for admin
    const u = activeUsers.get(socket.id);
    if(u) { u.room = null; activeUsers.set(socket.id, u); }
    broadcastAdminUpdate();
    
    socket.roomId = null;
  });

  socket.on('disconnect', () => {
    onlineUsers--;
    io.emit('online_count', onlineUsers); // Update count on disconnect
    
    // Clean up admin tracking
    activeUsers.delete(socket.id);
    if (socket.id === adminSocketId) adminSocketId = null;
    
    if (waitingUser && waitingUser.id === socket.id) waitingUser = null;
    if (socket.roomId) socket.to(socket.roomId).emit('partner_left');
    
    broadcastAdminUpdate();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Vartalap running on port ${PORT}`));
          
