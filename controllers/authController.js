// controllers/authController.js
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const config = require('../config');
const rolePermissions = require('../rolePermissions');
const allPermissions = require("../permissions");
const crypto = require('crypto');
const { sendEmail } = require('../utils/emailUtil');
const AuditLog = require('../models/AuditLog'); // Importar o modelo de auditoria

exports.register = async (req, res) => {
  try {
    const { nome, email, senha, role, permissions, managerId } = req.body; // Adicionado managerId

    let userPermissions = permissions;

    if (!permissions || permissions.length === 0) {
      // Se nenhuma permissão for fornecida, atribua as permissões padrão da role
      userPermissions = rolePermissions[role] || [];
    }

    if (role !== 'admin' && userPermissions.includes('*')) {
      return res.status(400).json({
        message: 'Somente usuários com role "admin" podem ter acesso total.',
      });
    }

    // Verificar se o usuário sendo criado é um agente e associar a um gerente
    let manager = null;
    if (role === 'agent') {
      // Verifica se o managerId foi fornecido
      if (!managerId) {
        return res.status(400).json({ message: 'ID do gerente é obrigatório para agentes.' });
      }

      // Busca o gerente no banco de dados
      manager = await User.findById(managerId);
      if (!manager || (manager.role !== 'manager' && manager.role !== 'admin')) {
        return res.status(400).json({ message: 'Gerente inválido.' });
      }
    }

    const user = new User({
      nome,
      email,
      senha,
      role,
      permissions: userPermissions,
      manager: manager ? manager._id : undefined, // Associar o gerente se houver
    });

    await user.save();

    // Registrar ação de criação de usuário
    await AuditLog.create({
      userId: req.user ? req.user.id : user._id, // Caso o usuário não esteja logado (registro inicial)
      userEmail: req.user ? req.user.email : user.email,
      action: 'register_user',
      details: {
        createdUserId: user._id,
        createdUserEmail: user.email,
        role: user.role,
      },
    });

    res.status(201).json({ message: 'Usuário registrado com sucesso' });
  } catch (error) {
    res.status(400).json({ message: 'Erro ao registrar usuário', error: error.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, senha } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Usuário não encontrado' });

    const isMatch = await user.comparePassword(senha);
    if (!isMatch) return res.status(400).json({ message: 'Senha incorreta' });
    
    if (user.role === 'admin') {
      user.permissions = allPermissions;
    }

    const token = jwt.sign(
      { id: user._id, role: user.role, permissions: user.permissions },
      config.jwtSecret,
      { expiresIn: '8h' }
    );

    // Registrar ação de login
    await AuditLog.create({
      userId: user._id,
      userEmail: user.email,
      action: 'login',
      details: {
        message: 'Usuário fez login',
        ip: req.ip,
      },
    });

    res.json({
      token,
      user: {
        id: user._id,
        nome: user.nome,
        email: user.email,
        role: user.role,
        permissions: user.permissions,
      },
    });
  } catch (error) {
    res.status(400).json({ message: 'Erro ao fazer login', error: error.message });
  }
};

exports.requestPasswordReset = async (req, res) => {
  try {
    const { email } = req.body;

    // Verificar se o usuário existe
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Usuário não encontrado' });

    // Gerar OTP e tempo de expiração
    const otp = Math.floor(100000 + Math.random() * 900000).toString(); // Gera um número de 6 dígitos
    const expires = Date.now() + 10 * 60 * 1000; // Expira em 10 minutos

    // Atualizar o usuário com o OTP e expiração
    user.resetPasswordOTP = otp;
    user.resetPasswordExpires = expires;
    await user.save();

    // Enviar o email com o OTP
    const subject = 'Recuperação de Senha';
    const text = `Seu código de recuperação de senha é: ${otp}. Ele expira em 10 minutos.`;
    await sendEmail(user.email, subject, text);

    res.json({ message: 'OTP enviado para o email cadastrado' });
  } catch (error) {
    res.status(500).json({ message: 'Erro ao solicitar recuperação de senha', error: error.message });
  }
};

exports.resetPasswordWithOTP = async (req, res) => {
  try {
    const { email, otp, novaSenha } = req.body;

    // Verificar se o usuário existe
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Usuário não encontrado' });

    // Verificar se o OTP é válido e não expirou
    if (user.resetPasswordOTP !== otp || user.resetPasswordExpires < Date.now()) {
      return res.status(400).json({ message: 'OTP inválido ou expirado' });
    }

    // Atualizar a senha do usuário
    user.senha = novaSenha;
    user.resetPasswordOTP = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: 'Senha redefinida com sucesso' });
  } catch (error) {
    res.status(500).json({ message: 'Erro ao redefinir senha', error: error.message });
  }
};
