const mongoose = require('mongoose');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job'); // Your existing Job model
const dbConnect = require('./dbConnect'); // Your MongoDB connection
const { sendEmail, extractEmailsFromText } = require('./helperFunctions/emailUtils');
require('dotenv').config();

// Email pattern for extracting emails from job descriptions
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

/**
 * Generate custom email content for Jobsin contacts
 * @returns {string} - HTML email content
 */
function generateJobsinEmailContent() {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
      <h2 style="color: #333;">Jobsin costs €500+ we charge €100</h2>
      
      <p>Hello,</p>
      
      <p>I noticed you're advertising on JobsinBrussels. We charge 100 (half their price)</p>
      
      <p>For the same price we offer a headhunting service - you'd pay 200 upfront and if you hire a candidate we propose we'd get a 1800 as a success fee</p>
      
      <p>We found candidates in 2 days for many of our clients (but normally we take a month). Our platform is trusted by teams at OpenAI, Anthropic, and Mistral.</p>
      
      <p>If you'd like to discuss how we can help with your recruitment needs or want to learn more about our services, I'd be happy to set up a call.</p>
      
      <p>
        Best regards,<br>
        Madan Chaolla Park<br>
        Zatjob | Founder<br>
        Phone: +393518681664
      </p>
      
      <div style="margin-top: 30px; text-align: center;">
        <a href="http://calendly.com/chaollapark" style="display: inline-block; padding: 10px 20px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 4px; margin-right: 10px;">Schedule a Meeting</a>
        <a href="https://www.eujobs.co/new-listing/form" style="display: inline-block; padding: 10px 20px; background-color: #008CBA; color: white; text-decoration: none; border-radius: 4px;">Post a Job</a>
      </div>
    </div>
  `;
}

const STORYBLOK_TOKEN = 'Tm0AEdGfJUmWBJcbrVXC7gtt';
const BASE_LIST_URL = 'https://api.storyblok.com/v1/cdn/stories';
const BASE_DETAIL_URL = 'https://api.storyblok.com/v1/cdn/stories';

function generateSlug(title, company, id) {
  const process = (str) =>
    (str || '')
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  return `${process(title)}-at-${process(company)}-${id.slice(-6)}`;
}

async function getJobUUIDs(limit = 100) {
  try {
    const res = await axios.get(BASE_LIST_URL, {
      params: {
        token: STORYBLOK_TOKEN,
        starts_with: 'jobs/',
        per_page: limit,
        sort_by: 'published_at:desc'
      },
    });

    console.log(`🔍 Found ${res.data.stories?.length || 0} jobs to process`);
    return res.data.stories || [];
  } catch (error) {
    console.error('❌ Error fetching job UUIDs:', error.message);
    return [];
  }
}

async function getJobDetails(uuid) {
  try {
    const res = await axios.get(`${BASE_DETAIL_URL}/${uuid}`, {
      params: {
        token: STORYBLOK_TOKEN,
        find_by: 'uuid',
      },
    });

    return {
      content: res.data.story.content,
      meta: {
        name: res.data.story.name,
        slug: res.data.story.slug,
        full_slug: res.data.story.full_slug,
        created_at: res.data.story.created_at,
        published_at: res.data.story.published_at,
        uuid: res.data.story.uuid
      }
    };
  } catch (error) {
    console.error(`❌ Error fetching job details for ${uuid}:`, error.message);
    return null;
  }
}

/**
 * Extract text content from Storyblok's rich text format
 * @param {Object} desc - Storyblok rich text object
 * @returns {string} Formatted text content
 */
function extractTextFromStoryblok(desc) {
  if (!desc || typeof desc !== 'object') return '';
  if (!Array.isArray(desc.content)) return '';

  return desc.content
    .map((block) => {
      // Handle paragraph and heading blocks
      if (block.type === 'paragraph' || block.type.includes('heading')) {
        // Extract text and preserve formatting like bold, italic
        if (Array.isArray(block.content)) {
          return block.content
            .map(c => {
              let text = c.text || '';
              // Add emphasis for marked text (bold, italic)
              if (c.marks && Array.isArray(c.marks)) {
                if (c.marks.some(m => m.type === 'bold')) {
                  text = `**${text}**`; // markdown bold
                }
                if (c.marks.some(m => m.type === 'italic')) {
                  text = `_${text}_`; // markdown italic
                }
              }
              return text;
            })
            .join(' ');
        }
        return '';
      }

      // Handle bullet lists
      if (block.type === 'bullet_list') {
        return (block.content || [])
          .map(item => {
            if (item.content) {
              return '• ' + item.content
                .map(i => {
                  if (i.content) {
                    return i.content
                      .map(c => c.text || '')
                      .join(' ');
                  }
                  return '';
                })
                .join(' ');
            }
            return '';
          })
          .join('\n');
      }

      // Handle ordered lists
      if (block.type === 'ordered_list') {
        return (block.content || [])
          .map((item, index) => {
            if (item.content) {
              return `${index + 1}. ` + item.content
                .map(i => {
                  if (i.content) {
                    return i.content
                      .map(c => c.text || '')
                      .join(' ');
                  }
                  return '';
                })
                .join(' ');
            }
            return '';
          })
          .join('\n');
      }

      // Handle other block types or return empty
      return '';
    })
    .filter(text => text.trim() !== '') // Remove empty blocks
    .join('\n\n');
}

/**
 * Extract email addresses from text content
 * @param {string} text - Text to search for emails
 * @returns {string|null} - First email found or null
 */
function extractEmailFromText(text) {
  if (!text) return null;
  
  const emails = text.match(EMAIL_PATTERN);
  return emails && emails.length > 0 ? emails[0] : null;
}

/**
 * Extract salary information from text
 * @param {string} text - Text to search for salary
 * @returns {number} - Estimated salary amount or 0
 */
function extractSalaryEstimate(text) {
  if (!text) return 0;
  
  // Look for common salary patterns
  const salaryPatterns = [
    /(?:salary|compensation).{1,30}(?:€|EUR|euro|Euro|\$)\s*([\d.,]+)\s*(?:per|\/)\s*(?:month|year|annum)/i,
    /(?:€|EUR|euro|Euro|\$)\s*([\d.,]+)\s*(?:per|\/)\s*(?:month|year|annum)/i,
    /([\d.,]+)\s*(?:€|EUR|euro|Euro|\$)\s*(?:per|\/)\s*(?:month|year|annum)/i
  ];
  
  for (const pattern of salaryPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      // Convert to number and handle thousands separators
      const valueStr = match[1].replace(/[.,]/g, '');
      const value = parseInt(valueStr, 10);
      if (!isNaN(value)) {
        return value;
      }
    }
  }
  
  return 0;
}

/**
 * Determine if job is remote based on text
 * @param {string} text - Job description or title
 * @returns {string} - Remote status ('yes', 'partial', 'no')
 */
function determineRemoteStatus(text) {
  if (!text) return 'no';
  
  const lowerText = text.toLowerCase();
  
  if (
    lowerText.includes('fully remote') || 
    lowerText.includes('100% remote') || 
    lowerText.match(/\bremote\b/) && !lowerText.includes('hybrid') && !lowerText.includes('office')
  ) {
    return 'yes';
  }
  
  if (
    lowerText.includes('hybrid') || 
    lowerText.includes('remote option') || 
    lowerText.includes('partially remote') ||
    (lowerText.includes('remote') && (lowerText.includes('office') || lowerText.includes('onsite')))
  ) {
    return 'partial';
  }
  
  return 'no';
}

  
/**
 * Main function to scrape and store jobs from Storyblok API
 */
async function scrapeStoryblokJobs() {
  await dbConnect();

  // Get job listings from API (increased from 3 to 25)
  const stories = await getJobUUIDs(25);
  if (!stories.length) {
    console.log('❌ No jobs found or error occurred');
    await mongoose.connection.close();
    return;
  }

  // Track stats
  let stats = {
    processed: 0,
    saved: 0,
    skipped: 0,
    errors: 0,
    emailsFound: 0
  };

  for (const story of stories) {
    try {
      stats.processed++;
      const jobData = await getJobDetails(story.uuid);
      
      if (!jobData || !jobData.content) {
        console.log(`⚠️ Missing content for job: ${story.uuid}`);
        stats.errors++;
        continue;
      }
      
      const fullJob = jobData.content;
      const meta = jobData.meta;

      // Extract job details with improved company name extraction
      const title = fullJob.title || meta.name?.split(' - ')[1] || 'Untitled';
      
      // Improved company name extraction
      const companyName =
        fullJob.employer ||
        fullJob.company ||
        fullJob.organisation_name ||
        fullJob.org ||
        fullJob.meta?.company ||
        fullJob.author ||
        // Try to extract from the story name which often has format "Company - Job Title"
        (meta.name?.includes(' - ') ? meta.name.split(' - ')[0].trim() : null) ||
        'Unknown Company';

      // Get apply link with fallbacks
      const applyLink =
        (fullJob.link?.url ||
        fullJob.link?.cached_url ||
        fullJob.apply_link?.url ||
        fullJob.apply_link?.cached_url ||
        '').toString();

      // Skip if job already exists
      const exists = await JobModel.findOne({ $or: [
        { applyLink },
        { slug: meta.slug }
      ]});
      
      if (exists) {
        console.log(`⚠️ Skipping existing job: ${title}`);
        stats.skipped++;
        continue;
      }

      // Generate description
      const description = extractTextFromStoryblok(fullJob.description || fullJob.body);
      
      // Extract all emails from description
      const emails = extractEmailsFromText(description);
      if (emails.length > 0) {
        console.log(`📧 Found ${emails.length} email(s): ${emails.join(', ')}`);
        stats.emailsFound += emails.length;
      }

      // Generate ID and slug
      const id = uuidv4();
      const slug = meta.slug || generateSlug(title, companyName, id);
      
      // Set expiry date with better handling
      const deadline = new Date(
        fullJob.expiry || 
        fullJob.paidUntil || 
        fullJob.deadline || 
        fullJob.application_deadline || 
        // Default to 30 days from now
        (new Date(Date.now() + 30 * 86400000)).toISOString()
      );
      
      // Created date
      const createdAt = new Date(meta.created_at || Date.now());
      const publishedAt = meta.published_at ? new Date(meta.published_at) : createdAt;
      
      // Extract location information
      const location = 
        fullJob.city_estimate || 
        fullJob.location || 
        (Array.isArray(fullJob.city) && fullJob.city.length > 0 ? fullJob.city.join(', ') : '');
      
      // Split location into city and country if possible
      let city = '', country = '';
      if (location && location.includes(',')) {
        const parts = location.split(',').map(p => p.trim());
        city = parts[0] || '';
        country = parts[parts.length - 1] || '';
      } else {
        city = location || '';
      }

      // Determine contract type
      let contractType = fullJob.contract || '';
      if (!contractType) {
        const lowText = description.toLowerCase();
        if (lowText.includes('permanent contract') || lowText.includes('indefinite')) {
          contractType = 'permanent';
        } else if (lowText.includes('fixed term') || lowText.includes('temporary')) {
          contractType = 'fixed-term';
        } else if (lowText.includes('freelance') || lowText.includes('contractor')) {
          contractType = 'freelance';
        } else if (lowText.includes('internship') || lowText.includes('trainee')) {
          contractType = 'internship';
        }
      }
      
      // Determine job type (full-time, part-time)
      let jobType = 'full-time';
      if (description.toLowerCase().includes('part-time') || description.toLowerCase().includes('part time')) {
        jobType = 'part-time';
      }
      
      // Determine seniority level
      let seniority = 'mid-level';
      const loweredTitle = title.toLowerCase();
      if (loweredTitle.includes('internship') || loweredTitle.includes('intern') || loweredTitle.includes('trainee')) {
        seniority = 'intern';
      } else if (loweredTitle.includes('junior') || loweredTitle.includes('assistant')) {
        seniority = 'junior';
      } else if (loweredTitle.includes('senior') || loweredTitle.includes('manager') || loweredTitle.includes('lead')) {
        seniority = 'senior';
      }
      
      // Get tags, combining job_area and tags
      const tags = [
        ...(Array.isArray(fullJob.job_area) ? fullJob.job_area : []),
        ...(Array.isArray(fullJob.tags) ? fullJob.tags : [])
      ];
      
      // Get salary if available or try to extract from description
      const salary = fullJob.salary || extractSalaryEstimate(description) || 0;
      
      // Determine remote status
      const remote = determineRemoteStatus(title + ' ' + description);

      // Create new job object with all available information
      const newJob = new JobModel({
        _id: new mongoose.Types.ObjectId(),
        title,
        slug,
        description,
        companyName,
        sourceAgency: fullJob.organisation || '',
        contractType,
        vacancyType: fullJob.highQuality ? 'premium' : 'standard',
        tags,
        remote,
        type: jobType,
        salary,
        city,
        country,
        state: '',
        applyLink,
        contactEmail,
        createdAt,
        updatedAt: new Date(),
        expiresOn: deadline,
        seniority,
        plan: 'basic',
        source: "jobsin",
        // Store additional data
        summary: fullJob.summary_long || '',
        relativeLink: meta.full_slug || ''
      });

      try {
        await newJob.save();
        stats.saved++;
        console.log(`✅ Saved: ${title} at ${companyName}`);
        
        // Send sales emails to found contacts if RESEND_API_KEY is configured
        if (process.env.RESEND_API_KEY && emails.length > 0) {
          try {
            const emailSubject = "Jobsin costs €500+ we charge €100";
            const emailContent = generateJobsinEmailContent();
            const sentEmails = new Set();
            
            for (const email of emails) {
              // Skip if already sent to this address
              if (sentEmails.has(email)) continue;
              
              // Send the email using Resend API
              const result = await sendEmail(email, emailSubject, emailContent, {
                jobTitle: title,
                companyName: companyName,
                source: 'jobsin'
              });
              
              if (!result.error) {
                sentEmails.add(email);
                console.log(`📨 Sales email sent to ${email} for ${title} at ${companyName}`);
                stats.emailsSent++;
                
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            }
            
            console.log(`📊 Sent emails to ${sentEmails.size} contacts for job: ${title}`);
          } catch (emailErr) {
            console.error(`❌ Error sending sales emails for ${title}:`, emailErr.message);
          }
        } else if (emails.length > 0 && !process.env.RESEND_API_KEY) {
          console.log(`⚠️ RESEND_API_KEY not configured. Skipping email sending.`);
        }
      } catch (err) {
        console.error(`❌ Failed to save ${title}:`, err.message);
        stats.errors++;
      }
    } catch (error) {
      console.error(`❌ Error processing job:`, error.message);
      stats.errors++;
    }
  }

  // Display statistics
  console.log('\n📊 Scraping Statistics:');
  console.log(`Processed: ${stats.processed} jobs`);
  console.log(`Saved: ${stats.saved} jobs`);
  console.log(`Skipped: ${stats.skipped} jobs`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`Emails found: ${stats.emailsFound}\n`);

  await mongoose.connection.close();
}

scrapeStoryblokJobs();
