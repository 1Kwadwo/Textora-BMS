const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  throw new Error('JWT_SECRET environment variable is required and must be at least 16 characters. Refusing to start with a weak or missing signing key.')
}

async function hashPassword(password) {
  const salt = await bcrypt.genSalt(10)
  return bcrypt.hash(password, salt)
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash)
}

function generateToken(user) {
  return jwt.sign(
    {
      userId: String(user._id || user.id),
      email: user.email,
      name: user.name
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  )
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch (err) {
    return null
  }
}

function extractBearerToken(req) {
  const authHeader = req.headers['authorization']
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim()
  }
  return null
}

module.exports = {
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  extractBearerToken
}
