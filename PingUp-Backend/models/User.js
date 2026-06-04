const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
{
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
  },
  
  password: {
    type: String,
    required: true,
  },

  role: {
    type: String,
    enum: ["owner", "moderator", "member"],
    default: "member",
  },

  email: {
    type: String,
    default: '',
    validate: {
      validator: function(v) {
        return v === '' || /^\S+@\S+\.\S+$/.test(v);
      },
      message: 'Please enter a valid email address.'
    }
  },

  displayName: {
    type: String,
    default: '',
  },

  phone: {
    type: String,
    default: '',
    validate: {
      validator: function(v) {
        return v === '' || /^\+?[0-9\-\s()]{7,20}$/.test(v);
      },
      message: 'Please enter a valid phone number.'
    }
  },

  online: {
    type: Boolean,
    default: false,
  },

  socketId: {
    type: String,
    default: null,
  },

  isFirst: {
    type: Boolean,
    default: false,
  },

  loginCount: {
    type: Number,
    default: 0,
  },

  refreshToken: {
    type: String,
    default: null,
  },
  banned: {
  type: Boolean,
  default: false,
},
},
{
  timestamps: true,
});

// Hash password before save
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

// Strip sensitive fields for public broadcast
userSchema.methods.toSafeObject = function () {
  return {
    id: this._id.toString(),
    username: this.username,
    displayName: this.displayName || this.username,
    role: this.role,
    online: this.online,
    isFirst: this.isFirst,
  };
};

// Full profile for the authenticated user
userSchema.methods.toPrivateProfile = function () {
  return {
    id: this._id.toString(),
    username: this.username,
    displayName: this.displayName || this.username,
    role: this.role,
    email: this.email,
    phone: this.phone,
    online: this.online,
    isFirst: this.isFirst,
  };
};

module.exports = mongoose.model("User", userSchema);
