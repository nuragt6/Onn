Const express = require('express');
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

io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('online_count', onlineUsers); // Broadcast count to everyone

  const userIp = socket.handshake.address;

  if (bans[userIp] && bans[userIp] > Date.now()) {
    socket.emit('banned', { message: 'You are banned for 1 minute.' });
    socket.disconnect();
    return;
  }

  socket.on('find_match', (userData) => {
    if (waitingUser && waitingUser.id !== socket.id) {
      const partner = waitingUser;
      waitingUser = null;

      const roomId = `room_${socket.id}_${partner.id}`;
      socket.join(roomId);
      partner.join(roomId);
      socket.roomId = roomId;
      partner.roomId = roomId;

      io.to(socket.id).emit('match_found', { initiator: true, partnerName: partner.userData?.name || 'Stranger' });
      io.to(partner.id).emit('match_found', { initiator: false, partnerName: userData?.name || 'Stranger' });
    } else {
      socket.userData = userData;
      waitingUser = socket;
    }
  });

  socket.on('offer', (data) => socket.to(socket.roomId).emit('offer', data));
  socket.on('answer', (data) => socket.to(socket.roomId).emit('answer', data));
  socket.on('ice_candidate', (data) => socket.to(socket.roomId).emit('ice_candidate', data));
  
  // Pass chat and reactions between peers
  socket.on('send_message', (message) => socket.to(socket.roomId).emit('receive_message', message));
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
    socket.roomId = null;
  });

  socket.on('disconnect', () => {
    onlineUsers--;
    io.emit('online_count', onlineUsers); // Update count on disconnect
    if (waitingUser && waitingUser.id === socket.id) waitingUser = null;
    if (socket.roomId) socket.to(socket.roomId).emit('partner_left');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Vartalap running on port ${PORT}`));
