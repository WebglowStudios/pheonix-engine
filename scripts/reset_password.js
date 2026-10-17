require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB\n');

    // --- List all users ---
    const users = await User.find({}, 'name email role createdAt');
    console.log(`Total users: ${users.length}`);
    console.log('─'.repeat(60));
    users.forEach(u => {
      console.log(`  ${u.email.padEnd(35)} role: ${u.role}  name: ${u.name}`);
    });
    console.log('─'.repeat(60) + '\n');

    // --- Reset password ---
    const targetEmail = 'admin@phoenixfiserv.co.in';
    const newPassword  = 'Admin#123';

    const user = await User.findOne({ email: targetEmail });
    if (!user) {
      console.error(`User "${targetEmail}" NOT FOUND in DB.`);
      process.exit(1);
    }

    // Hash manually, then write directly via updateOne to bypass pre-save hook
    const salt = await bcrypt.genSalt(12);
    const hashed = await bcrypt.hash(newPassword, salt);

    await User.updateOne({ email: targetEmail }, { $set: { password: hashed } });

    // Verify it works
    const updated = await User.findOne({ email: targetEmail }).select('+password');
    const isMatch = await bcrypt.compare(newPassword, updated.password);

    if (isMatch) {
      console.log(`✅ Password reset & verified for: ${updated.email} (${updated.name})`);
      console.log(`   Login with: ${targetEmail} / ${newPassword}`);
    } else {
      console.error('❌ Verification failed — hash mismatch. Something went wrong.');
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

run();
