const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const SECRET_KEY = process.env.JWT_SECRET || 'your-secret-key';

require('dotenv').config();
// Database connection
const connection = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

// Multer setup for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/') // Make sure this folder exists
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname))
    }
});

const upload = multer({ storage: storage });

// Token generation function
function generateToken(user, role) {
    return jwt.sign(
        {
            id: user.id,
            email: user.email,
            role: role // 'doctor' or 'patient' or 'admin'
        },
        SECRET_KEY,
        { expiresIn: '1d' }
    );
}


// Middleware to verify token and check role
function verifyToken(requiredRole) {
    return (req, res, next) => {
        const bearerHeader = req.headers['authorization'];
        console.log('Authorization header:', bearerHeader);
        
        if (!bearerHeader) {
            console.error('No Authorization header provided');
            return res.status(401).json({ error: 'No token provided' });
        }

        const bearer = bearerHeader.split(' ');
        if (bearer.length !== 2 || bearer[0] !== 'Bearer') {
            console.error('Invalid Authorization header format');
            return res.status(401).json({ error: 'Invalid token format' });
        }

        const token = bearer[1];
        console.log('Token to verify:', token);

        jwt.verify(token, SECRET_KEY, (err, decoded) => {
            if (err) {
                console.error('Token verification error:', err);
                return res.status(401).json({ error: 'Unauthorized' });
            }
            console.log('Decoded token:', decoded);
            if (decoded.role !== requiredRole) {
                console.error('Access denied. Incorrect role:', decoded.role);
                return res.status(403).json({ error: 'Access denied. Incorrect role.' });
            }
            req.userId = decoded.id;
            req.userEmail = decoded.email;
            req.userRole = decoded.role;
            next();
        });
    };
}



// Patient profile route
app.get('/profile', verifyToken('patient'), (req, res) => {
    const sql = `SELECT id, firstname, lastname, email, profilePicture FROM users WHERE id = ?`;

    connection.query(sql, [req.userId], (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Error occurred while fetching profile' });
        }
        if (results.length > 0) {
            res.json(results[0]);
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    });
});

// Profile picture upload route
app.post('/upload-profile-picture', verifyToken('patient'), upload.single('profilePicture'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = `/uploads/${req.file.filename}`;
    const sql = `UPDATE users SET profilePicture = ? WHERE id = ?`;

    connection.query(sql, [filePath, req.userId], (err, result) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Error occurred while updating profile picture' });
        }
        res.json({ message: 'Profile picture updated successfully', profilePicture: filePath });
    });
});

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Patient Signup route
app.post('/signup', async (req, res) => {
    console.log('Signup request received:', req.body);
    const { firstname, lastname, email, password, confirmPassword } = req.body;

    if (!firstname || !lastname || !email || !password || !confirmPassword) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    if (password !== confirmPassword) {
        return res.status(400).json({ error: 'Passwords do not match' });
    }

    try {
        const [existingUsers] = await connection.promise().query('SELECT * FROM users WHERE email = ?', [email]);
        if (existingUsers.length > 0) {
            return res.status(400).json({ error: 'Patient with this email already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const sql = `INSERT INTO users (firstname, lastname, email, password) VALUES (?, ?, ?, ?)`;
        const [result] = await connection.promise().query(sql, [firstname, lastname, email, hashedPassword]);

        res.status(201).json({ message: 'User signed up successfully!', userId: result.insertId });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: 'Error occurred while signing up' });
    }
});

// Route to get all appointments for a specific patient
app.get('/appointments', verifyToken('patient'), (req, res) => {
    const sql = `
        SELECT appointments.*, doctors.name AS doctor_name, doctors.specialty AS doctor_specialty 
        FROM appointments 
        JOIN doctors ON appointments.doctors_id = doctors.id
        WHERE appointments.users_id = ?
    `; // Assuming `doctor_id` is a foreign key in `appointments` that references `doctors`

    connection.query(sql, [req.userId], (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Failed to retrieve appointments' });
        }
        res.json(results);
    });
});


// Route to book an appointment
app.post('/appointments', verifyToken('patient'), (req, res) => {
    const { doctorId, appointmentDateTime } = req.body;

    if (!doctorId || !appointmentDateTime) {
        return res.status(400).json({ success: false, message: 'Missing data' });
    }

    const sql = 'INSERT INTO appointments (doctors_id, users_id, date_time) VALUES (?, ?, ?)';
    connection.query(sql, [doctorId, req.userId, appointmentDateTime], (err, result) => {
        if (err) {
            console.error('Error saving appointment:', err);
            return res.status(500).json({ success: false, message: 'Failed to book appointment' });
        }
        res.json({ success: true, message: 'Appointment booked successfully', appointmentId: result.insertId });
    });
});



// Route to cancel an appointment
app.delete('/appointments/:id', verifyToken('patient'), (req, res) => {
    const appointmentId = parseInt(req.params.id);
    const sql = 'DELETE FROM appointments WHERE id = ? AND users_id = ?'; // Ensure the patient can only cancel their own appointments
    connection.query(sql, [appointmentId, req.userId], (err, result) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Failed to cancel appointment' });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Appointment not found or access denied' });
        }
        res.json({ success: true, message: 'Appointment canceled successfully' });
    });
});

// Route to update an appointment
app.put('/appointments/:id', verifyToken('patient'), (req, res) => {
    const appointmentId = parseInt(req.params.id);
    const { doctorId, appointmentDateTime } = req.body;

    const sql = 'UPDATE appointments SET doctors_id = ?, date_time = ? WHERE id = ? AND users_id = ?';
    connection.query(sql, [doctorId, appointmentDateTime, appointmentId, req.userId], (err, result) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Failed to update appointment' });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Appointment not found or access denied' });
        }
        res.json({ success: true, message: 'Appointment updated successfully' });
    });
});


// Doctor registration route
app.post('/drregister', async (req, res) => {
    const { name, email, password, specialty } = req.body;

    if (!name || !email || !password || !specialty) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    try {
        const [existingDoctors] = await connection.promise().query('SELECT * FROM doctors WHERE email = ?', [email]);
        if (existingDoctors.length > 0) {
            return res.status(400).json({ error: 'Doctor with this email already exists' });
        }

        if (name.length < 2) {
            return res.status(400).json({ error: 'Name must be at least 2 characters long' });
        }

        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailPattern.test(email)) {
            return res.status(400).json({ error: 'Please enter a valid email address' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters long' });
        }

        const validSpecialties = ['Cardiology', 'Neurology', 'Pediatrics', 'Orthopedics', 'Dermatology', 'General Medicine'];
        if (!validSpecialties.includes(specialty)) {
            return res.status(400).json({ error: 'Invalid specialty selected' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const sql = 'INSERT INTO doctors (name, email, password, specialty) VALUES (?, ?, ?, ?)';
        const [result] = await connection.promise().query(sql, [name, email, hashedPassword, specialty]);

        res.status(201).json({ message: 'Doctor signed up successfully!', userId: result.insertId });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: 'Error occurred while signing up' });
    }
});

// Patient Login route
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    const sql = 'SELECT * FROM users WHERE email = ?';
    connection.query(sql, [email], async (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Error occurred during login' });
        }

        if (results.length === 0) {
            return res.status(401).json({ error: 'Incorrect email or password' });
        }

        const user = results[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Incorrect email or password' });
        }

        // Generate a token with the correct role
        const token = generateToken(user, 'patient'); // Explicitly set role to 'patient'
        res.json({ message: 'Login successful', token });
    });
});

// Route to fetch doctors for appointment
app.get('/doctors', verifyToken('patient'), (req, res) => {
    const sql = 'SELECT id, name, email, specialty FROM doctors'; 
    connection.query(sql, (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Failed to retrieve doctors' });
        }
        if (results.length === 0) {
            return res.status(404).json({ message: 'No doctors found' });
        }
        res.json(results); // Send the doctors list as JSON
    });
});

// Doctor login route
app.post('/drlogin', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const [results] = await connection.promise().query('SELECT * FROM doctors WHERE email = ?', [email]);

        if (results.length === 0) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const doctor = results[0];
        const match = await bcrypt.compare(password, doctor.password);

        if (!match) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const token = generateToken(doctor, 'doctor'); // Explicitly set role to 'doctor'
        return res.json({ message: 'Login successful', token });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

//getting doctors appointments
app.get('/drappointments', verifyToken('doctor'), (req, res) => {
    const sql = `
        SELECT 
            appointments.*,
            users.firstname AS patient_firstname,
            users.lastname AS patient_lastname
        FROM users_telemedicine.appointments 
        JOIN users_telemedicine.users ON appointments.users_id = users.id
        WHERE appointments.doctors_id = ?
    `;

    connection.query(sql, [req.userId], (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Failed to retrieve appointments' });
        }
        res.json(results);
    });
});

// Doctor profile route (example)
app.get('/drprofile', verifyToken('doctor'), (req, res) => {
    const sql = `SELECT id, name, email, specialty FROM doctors WHERE id = ?`;

    connection.query(sql, [req.userId], (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Error occurred while fetching profile' });
        }
        if (results.length > 0) {
            res.json(results[0]);
        } else {
            res.status(404).json({ error: 'Doctor not found' });
        }
    });
});

//admin login
app.post('/adminlogin', async (req, res) => {
    const { email, password } = req.body;
    console.log('Login attempt for email:', email); // Log the email being used

    if (!email || !password) {
        console.log('Missing email or password');
        return res.status(400).json({ error: 'Email and password are required' });
    }

    const sql = 'SELECT * FROM admin WHERE email = ?';
    connection.query(sql, [email], async (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Error occurred during login' });
        }

        if (results.length === 0) {
            console.log('No admin found with the provided email');
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const admin = results[0];
        console.log('Admin found:', { id: admin.id, email: admin.email, role: admin.role });
        console.log('Stored hash:', admin.password);

        const isMatch = await bcrypt.compare(password, admin.password);
        console.log('Password match:', isMatch);

        if (!isMatch) {
            console.log('Password mismatch');
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { id: admin.id, email: admin.email, role: 'admin' },
            SECRET_KEY,
            { expiresIn: '1d' }
        );
        console.log('Generated token:', token);

        res.json({ message: 'Admin login successful', token });
    });
});

//admin fetch doctors
// Admin route to fetch all patients
app.get('/admin/patients', verifyToken('admin'), (req, res) => {
    const sql = `SELECT id, firstname, lastname, email FROM users`;

    connection.query(sql, (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Failed to retrieve patients' });
        }
        res.json(results);
    });
});

// Admin route to fetch all doctors
app.get('/admin/doctors', verifyToken('admin'), (req, res) => {
    const sql = `SELECT id, name, email, specialty FROM doctors`;

    connection.query(sql, (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Failed to retrieve doctors' });
        }
        res.json(results);
    });
});

// Admin route to fetch all appointments
app.get('/admin/appointments', verifyToken('admin'), (req, res) => {
    const sql = `
        SELECT 
            appointments.*,
            users.firstname AS patient_firstname,
            users.lastname AS patient_lastname,
            doctors.name AS doctor_name,
            doctors.specialty AS doctor_specialty
        FROM appointments
        JOIN users ON appointments.users_id = users.id
        JOIN doctors ON appointments.doctors_id = doctors.id
    `;

    connection.query(sql, (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Failed to retrieve appointments' });
        }
        res.json(results);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});