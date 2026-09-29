require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Investment = require('../models/Investment');

async function seed() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const user = await User.findOne({ email: 'kobejo2532@dreameg.com' });
    if (!user) {
      console.error('User kobejo2532@dreameg.com not found!');
      process.exit(1);
    }
    console.log('Seeding portfolio for user:', user.name, user.email, user._id);

    const dummyItems = [
      // Mutual Funds (Lump-sum)
      {
        userId: user._id,
        type: 'mutual_fund',
        name: 'Parag Parikh Flexi Cap Fund - Direct Plan',
        symbol: '122639',
        units: 3500.25,
        buyPrice: 52.40,
        investedAmount: 183413,
        currentPrice: 84.65,
        buyDate: new Date('2023-01-15'),
        institution: 'PPFAS Mutual Fund'
      },
      {
        userId: user._id,
        type: 'mutual_fund',
        name: 'HDFC Top 100 Fund - Growth Plan',
        symbol: '100119',
        units: 520.40,
        buyPrice: 620.00,
        investedAmount: 322648,
        currentPrice: 948.30,
        buyDate: new Date('2022-06-20'),
        institution: 'HDFC Mutual Fund'
      },
      {
        userId: user._id,
        type: 'mutual_fund',
        name: 'Mirae Asset Large & Midcap Fund - Reg Growth',
        symbol: '107532',
        units: 4200.10,
        buyPrice: 78.50,
        investedAmount: 329707,
        currentPrice: 148.50,
        buyDate: new Date('2022-09-10'),
        institution: 'Mirae Asset Mutual Fund'
      },

      // Systematic Investment Plans (SIP)
      {
        userId: user._id,
        type: 'sip',
        name: 'Nippon India Small Cap Fund - Growth (SIP)',
        symbol: '118778',
        sipAmount: 15000,
        instalments: 30,
        avgNav: 95.20,
        investedAmount: 450000,
        currentPrice: 168.40,
        sipStartDate: new Date('2022-08-01'),
        institution: 'Nippon India Mutual Fund'
      },
      {
        userId: user._id,
        type: 'sip',
        name: 'SBI Bluechip Fund - Regular Growth (SIP)',
        symbol: '103004',
        sipAmount: 10000,
        instalments: 24,
        avgNav: 62.40,
        investedAmount: 240000,
        currentPrice: 88.20,
        sipStartDate: new Date('2023-01-01'),
        institution: 'SBI Mutual Fund'
      },

      // Fixed Deposits (FD)
      {
        userId: user._id,
        type: 'fd',
        name: 'HDFC Bank 3-Yr Cumulative Term Deposit',
        principal: 500000,
        interestRate: 7.25,
        tenureMonths: 36,
        institution: 'HDFC Bank',
        investedAmount: 500000,
        buyDate: new Date('2023-03-01'),
        maturityDate: new Date('2026-03-01')
      },
      {
        userId: user._id,
        type: 'fd',
        name: 'Bajaj Finance Fixed Deposit',
        principal: 300000,
        interestRate: 8.15,
        tenureMonths: 24,
        institution: 'Bajaj Finance Ltd',
        investedAmount: 300000,
        buyDate: new Date('2023-08-15'),
        maturityDate: new Date('2025-08-15')
      },

      // PPF & EPF
      {
        userId: user._id,
        type: 'ppf',
        name: 'SBI Public Provident Fund',
        principal: 450000,
        interestRate: 7.10,
        institution: 'State Bank of India',
        investedAmount: 450000,
        buyDate: new Date('2020-04-01'),
        maturityDate: new Date('2035-04-01')
      },
      {
        userId: user._id,
        type: 'epf',
        name: 'Employees Provident Fund',
        principal: 680000,
        interestRate: 8.25,
        institution: 'EPFO India',
        investedAmount: 680000,
        buyDate: new Date('2019-07-01')
      },

      // NPS
      {
        userId: user._id,
        type: 'nps',
        name: 'NPS Tier 1 - HDFC Pension Fund Scheme E',
        principal: 350000,
        interestRate: 10.50,
        institution: 'HDFC Pension Management / PFRDA',
        investedAmount: 350000,
        buyDate: new Date('2021-10-01')
      },

      // Gold / SGB
      {
        userId: user._id,
        type: 'gold',
        name: 'Sovereign Gold Bond (SGB 2021-22 Series VIII)',
        symbol: 'SGBNOV29',
        units: 45,
        buyPrice: 4791,
        investedAmount: 215595,
        currentPrice: 7520,
        buyDate: new Date('2021-11-05'),
        institution: 'Reserve Bank of India'
      },

      // Bonds
      {
        userId: user._id,
        type: 'bond',
        name: 'NHAI 8.20% Tax-Free Infrastructure Bonds',
        principal: 150000,
        units: 150,
        buyPrice: 1000,
        interestRate: 8.20,
        institution: 'NHAI',
        investedAmount: 150000,
        buyDate: new Date('2022-04-12'),
        maturityDate: new Date('2032-04-12')
      },

      // Crypto
      {
        userId: user._id,
        type: 'crypto',
        name: 'Bitcoin',
        symbol: 'BTC',
        units: 0.025,
        buyPrice: 3400000,
        investedAmount: 85000,
        currentPrice: 5850000,
        buyDate: new Date('2023-11-10'),
        institution: 'Hardware Cold Wallet'
      }
    ];

    const inserted = await Investment.insertMany(dummyItems);
    console.log('Successfully inserted', inserted.length, 'new multi-asset investments!');

    const totalCount = await Investment.countDocuments({ userId: user._id });
    console.log('Total investments now for user:', totalCount);

    const counts = {};
    const userInvs = await Investment.find({ userId: user._id });
    userInvs.forEach(i => {
      counts[i.type] = (counts[i.type] || 0) + 1;
    });
    console.log('Holdings by asset class:', counts);

    await mongoose.disconnect();
  } catch (err) {
    console.error('Seeding error:', err);
    process.exit(1);
  }
}

seed();
