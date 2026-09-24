// prompts.js — the agent personas and prompts of the Instructional Agents ADDIE pipeline,
// mirrored from src/ADDIE.py and src/slides.py of DaRL-GenAI/instructional_agents.
// Everything here is shown to the user verbatim in the "Prompt" tab and can be edited before a run.

export const AGENTS = {
  teaching_faculty_goals: {
    name: 'Teaching Faculty', role: 'Professor defining instructional goals',
    system: 'You are a Teaching Faculty responsible for defining clear learning objectives based on accreditation standards, competency gaps, and institutional needs. Your goal is to draft a set of course objectives aligned with industry expectations and discuss with the department committee to refine them for curriculum integration.',
  },
  instructional_designer_goals: {
    name: 'Instructional Designer', role: 'Expert in curriculum design and alignment',
    system: 'You are an Instructional Designer responsible for reviewing proposed learning objectives, assessing alignment with accreditation requirements, and suggesting modifications for consistency within the broader curriculum.',
  },
  teaching_faculty_learners: {
    name: 'Teaching Faculty', role: 'Professor analyzing student needs',
    system: 'You are a Teaching Faculty responsible for identifying student learning needs based on prior knowledge, enrollment trends, and academic performance data. Your goal is to analyze gaps in student learning, assess common challenges, and discuss findings to ensure course design meets diverse student needs.',
  },
  course_coordinator_learners: {
    name: 'Course Coordinator', role: 'Coordinator reviewing learner analysis',
    system: 'You are a Course Coordinator responsible for reviewing the analysis of student needs, ensuring it reflects enrollment data, prerequisite knowledge and institutional support services, and recommending adjustments so the course design serves diverse learners.',
  },
  teaching_faculty_resources: {
    name: 'Teaching Faculty', role: 'Professor assessing resource requirements',
    system: 'You are a Teaching Faculty responsible for determining the feasibility of courses based on faculty expertise, facility resources, and scheduling constraints. Your goal is to provide input on teaching requirements and ensure necessary instructional resources are available for effective course delivery.',
  },
  instructional_designer_resources: {
    name: 'Instructional Designer', role: 'Technology and resource assessment specialist',
    system: 'You are an Instructional Designer responsible for assessing whether current instructional technologies and platforms support proposed courses, identifying potential limitations, and collaborating to propose viable solutions.',
  },
  teaching_faculty_syllabus: {
    name: 'Teaching Faculty', role: 'Professor designing course syllabus',
    system: 'You are a Professor responsible for creating a structured syllabus that defines course content, pacing, and expected learning outcomes. Your goal is to draft a syllabus including weekly topics, learning objectives, required readings, and grading policies.',
  },
  committee_syllabus: {
    name: 'Instructional Designer', role: 'Department committee member reviewing syllabus',
    system: 'You are a Department Committee Member responsible for reviewing syllabus drafts, assessing alignment with institutional policies and accreditation requirements, and providing recommendations for improvement.',
  },
  teaching_faculty_assessment: {
    name: 'Teaching Faculty', role: 'Professor planning course assessments',
    system: "You are a Professor responsible for designing a course's assessment and evaluation strategy. Your task is to define project-based, milestone-driven, and real-world-relevant assessments, including formats, timing, grading rubrics, and submission logistics. Avoid traditional exam-heavy approaches.",
  },
  committee_assessment: {
    name: 'Instructional Designer', role: 'Department committee member reviewing assessment plans',
    system: 'You are a Department Committee Member responsible for evaluating assessment plans to ensure they align with institutional policies, learning outcomes, and best practices in competency-based education. Provide constructive feedback on assessment design, balance, and fairness.',
  },
  teaching_faculty_final: {
    name: 'Teaching Faculty', role: 'Professor designing the final project',
    system: 'You are a Professor designing a project-based final assessment that replaces the traditional exam. The final project should align with course learning objectives and simulate real-world problem-solving. Consider incorporating multiple milestones (e.g., proposal, progress update, final deliverable), interdisciplinary elements, and collaborative or individual work formats. The assessment must promote critical thinking, applied skills, and authentic data usage.',
  },
  committee_final: {
    name: 'Instructional Designer', role: 'Department committee member reviewing final project design',
    system: "You are a Department Committee Member responsible for reviewing and refining the design of a final project that serves as the course's summative assessment. Ensure alignment with course objectives, student workload balance, inclusive learning principles, and institutional policy. Offer suggestions on clarity, scaffolding, fairness, and the use of feedback loops like peer or instructor checkpoints.",
  },
  syllabus_processor: {
    name: 'Syllabus Processor', role: 'Syllabus organizer and formatter',
    system: 'You are a Syllabus Processor responsible for analyzing a course syllabus and extracting its weekly topics and schedule. Your task is to create a structured list of chapters, each with a title and brief introduction. The format should be clear and consistent, making it easy to understand the course structure.',
  },
  slides_designer: {
    name: 'Instructional Designer', role: 'Slide structure designer',
    system: 'You are an Instructional Designer who plans lecture slide decks. You produce a logical, well-paced outline that covers a chapter completely, moving from motivation to concepts, examples, and synthesis.',
  },
  slides_faculty: {
    name: 'Teaching Faculty', role: 'Subject expert writing slide content',
    system: 'You are a Teaching Faculty member writing lecture slides. You explain concepts clearly and precisely, use concrete examples, and keep each slide focused so that it fits on a single slide.',
  },
  script_writer: {
    name: 'Teaching Faculty', role: 'Lecturer writing the spoken script',
    system: 'You are a lecturer writing the spoken narration for each slide. You speak naturally to students, connect slides with transitions, and never read the bullet points verbatim.',
  },
  teaching_assistant: {
    name: 'Teaching Assistant', role: 'Assessment and lab author',
    system: 'You are a Teaching Assistant who writes homework, quizzes and hands-on labs. Your questions are unambiguous, aligned with the stated learning objectives, and come with model answers, rubrics and common pitfalls.',
  },
  reviewer: {
    name: 'Program Chair', role: 'Quality reviewer',
    system: 'You are a Program Chair reviewing generated teaching materials for accuracy, alignment with objectives, appropriate difficulty and clarity. You give a short, specific list of issues and a 1–10 score.',
  },
};

export const SUMMARIZER = (topic, constraint) => ({
  name: 'Summarizer', role: 'Executive summary creator',
  system: `You are a Summarizer for ${topic}. ${constraint}`,
});

// Foundation deliberations: two agents discuss for one round, then a summarizer writes the deliverable.
export const FOUNDATION = [
  {
    id: 'objectives', name: 'Instructional Goals Definition', file: 'learning_objectives.md', phase: 'Analysis',
    agents: ['teaching_faculty_goals', 'instructional_designer_goals'],
    instruction: 'Start by defining clear instructional goals.',
    summarizer: SUMMARIZER('instructional goals discussions', 'Please generate a set of well-defined learning objectives that align with accreditation standards, address curriculum gaps, and meet industry needs. Only generate the learning objectives, no other text.'),
  },
  {
    id: 'learners', name: 'Learner Analysis', file: 'learner_analysis.md', phase: 'Analysis',
    agents: ['teaching_faculty_learners', 'course_coordinator_learners'],
    instruction: 'Analyze the target learners for this course: prior knowledge and prerequisites, likely misconceptions, motivation, diversity of backgrounds, and support needed. Conclude with implications for course design.',
    summarizer: SUMMARIZER('Learner Analysis', 'Please generate a detailed learner analysis document covering learner profile, prerequisites, anticipated challenges and design implications. Only generate the document, no other text.'),
  },
  {
    id: 'resources', name: 'Resource & Constraints Assessment', file: 'resource_assessment.md', phase: 'Analysis',
    agents: ['teaching_faculty_resources', 'instructional_designer_resources'],
    instruction: 'Evaluate the resources needed and constraints to consider for delivering the course. Consider faculty expertise requirements, necessary computing resources, software requirements, and any scheduling or facility limitations.',
    summarizer: SUMMARIZER('Resource & Constraints Assessment', 'Please generate a detailed assessment of available resources, constraints, and technological requirements for effective course delivery. Only generate the document, no other text.'),
  },
  {
    id: 'syllabus', name: 'Syllabus & Learning Objectives Design', file: 'syllabus.md', phase: 'Design',
    agents: ['teaching_faculty_syllabus', 'committee_syllabus'],
    instruction: 'Develop a comprehensive syllabus for the course. Include weekly topics, required readings, learning objectives, and assessment methods. Ensure alignment with previously defined instructional goals and student needs.',
    summarizer: SUMMARIZER('Course Syllabus Design', 'Please generate a complete syllabus with course structure, objectives, weekly topics, and assessment schedule. Format the syllabus in a clear, structured manner that can be easily parsed into chapters: use one heading per week/chapter with a title and a 1–2 sentence description. Only generate the document, no other text.'),
  },
  {
    id: 'assessment_plan', name: 'Assessment & Evaluation Planning', file: 'assessment_plan.md', phase: 'Design',
    agents: ['teaching_faculty_assessment', 'committee_assessment'],
    instruction: 'Design a complete assessment and evaluation plan for the course. Include project-based evaluations, milestone breakdowns (e.g., proposals, progress reports), question types (open-ended, MCQs), grading rubrics, and submission formats (.pdf, .ipynb via Canvas LMS). Replace the final exam with a cumulative or staged final project. Emphasize real-world application and analytical thinking.',
    summarizer: SUMMARIZER('Course Assessment Planning', 'Please generate a structured document that outlines assessment types, milestone structure, grading criteria, submission formats, and delivery platforms. Ensure clarity, real-world relevance, and alignment with course objectives. Only generate the final assessment planning document, no extra explanations.'),
  },
  {
    id: 'final_project', name: 'Final Project Assessment Design', file: 'final_project.md', phase: 'Design',
    agents: ['teaching_faculty_final', 'committee_final'],
    instruction: 'Collaboratively design a final project to replace the traditional final exam. The project should reflect course objectives, be broken into multiple milestones (e.g., proposal, draft, final submission), and emphasize real-world data or scenarios. Include details such as team vs. individual work, submission format (.pdf, .ipynb, etc.), Canvas LMS compatibility, assessment rubrics, peer/instructor feedback checkpoints, and academic integrity considerations. The final deliverable should demonstrate applied learning and higher-order thinking.',
    summarizer: SUMMARIZER('Final Project Planning', 'Please generate a structured final project plan that includes a description, objectives, timeline with milestones, deliverables, grading rubric, submission formats, and academic integrity guidelines. The project should reflect real-world relevance and encourage analytical thinking. Only generate the final project plan document. Do not include extra explanations or commentary.'),
  },
];

export const CHAPTER_STAGES = [
  { id: 'outline', name: 'Slides outline', kind: 'json', file: 'outline.json', agent: 'slides_designer', module: 'slides' },
  { id: 'slides', name: 'Slides', kind: 'slides', file: 'slides.json', agent: 'slides_faculty', module: 'slides' },
  { id: 'script', name: 'Lecture script', kind: 'script', file: 'script.md', agent: 'script_writer', module: 'slides' },
  { id: 'homework', name: 'Homework', kind: 'md', file: 'homework.md', agent: 'teaching_assistant', module: 'assessments' },
  { id: 'lab', name: 'Lab', kind: 'md', file: 'lab.md', agent: 'teaching_assistant', module: 'assessments' },
  { id: 'quiz', name: 'Quiz', kind: 'quiz', file: 'quiz.json', agent: 'teaching_assistant', module: 'assessments' },
  { id: 'video', name: 'Lecture video', kind: 'video', file: 'video.webm', agent: null, module: 'videos' },
];
export const EXAMS = [
  { id: 'midterm', name: 'Midterm exam', file: 'midterm_exam.md', scope: 'first half' },
  { id: 'final', name: 'Final exam', file: 'final_exam.md', scope: 'whole course' },
];

export function courseContext(course) {
  const lines = [
    `Course name: ${course.name || '(unnamed course)'}`,
    course.subject ? `Subject area: ${course.subject}` : null,
    course.level ? `Level: ${course.level}` : null,
    course.audience ? `Target learners: ${course.audience}` : null,
    course.weeks ? `Duration: ${course.weeks} weeks` : null,
    course.language && course.language !== 'English' ? `Write all deliverables in ${course.language}.` : null,
    course.notes ? `Additional requirements from the instructor:\n${course.notes}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

export function priorContext(prior) {
  // prior: array of {label, text}
  return prior.filter(p => p.text && p.text.trim()).map(p => `### ${p.label}\n${p.text.trim()}`).join('\n\n');
}

export function textbookContext(chunks) {
  if (!chunks || !chunks.length) return '';
  return 'Reference excerpts from the instructor-supplied textbook (ground the content in these where relevant; do not invent citations):\n' +
    chunks.map((c, i) => `[Excerpt ${i + 1}${c.page ? `, p.${c.page}` : ''}]\n${c.text.trim()}`).join('\n\n');
}

export const PROMPTS = {
  deliberationOpen: (d, course, prior) => `${courseContext(course)}

${d.instruction}

${prior ? `Context produced in earlier deliberations:\n\n${prior}` : ''}`.trim(),

  deliberationReply: (d, otherName, otherText) => `Here is the proposal from the ${otherName}:

${otherText}

Review it critically from your role's perspective. Point out gaps, misalignments and concrete improvements, then give your revised version.`,

  deliberationSummary: (d, discussion) => `Below is the discussion of the ${d.name} deliberation.

${discussion}

Write the final deliverable in well-structured Markdown.`,

  chapters: (course, syllabus) => `Please analyze the following syllabus content and extract its weekly topics and schedule.
Format your response as a JSON array of objects, each with 'title' and 'description' fields.

Syllabus Content:
${syllabus}

Example format:
[
  {"title": "Chapter 1: Introduction to Machine Learning", "description": "Overview of basic machine learning concepts and applications."},
  ...
]

Important: Your entire response must be valid JSON. Do not include any explanatory text before or after the JSON array.`,

  outline: (course, chapter, n, prior, textbook) => `Based on the following chapter information, create a detailed slides outline in JSON format.

${courseContext(course)}

Chapter Title: ${chapter.title}
Chapter Description: ${chapter.description}

${prior ? `Course context:\n${prior}\n` : ''}${textbook ? `${textbook}\n` : ''}
Please generate a comprehensive slides outline with about ${n} slides covering all important aspects of this chapter.
The outline should be a JSON array with the following structure:
[
  {"slide_id": 1, "title": "Introduction to Topic", "description": "Brief overview of the main topic"},
  {"slide_id": 2, "title": "Key Concepts", "description": "Explanation of key concepts"}
]
Start with a title/agenda slide and end with a summary slide. Your response must be valid JSON that can be parsed programmatically.`,

  slides: (course, chapter, outline, prior, textbook) => `Please create the detailed content for every slide in the outline below.

${courseContext(course)}

Chapter: ${chapter.title}
Description: ${chapter.description}

Slides outline:
${JSON.stringify(outline, null, 2)}

${prior ? `Course context:\n${prior}\n` : ''}${textbook ? `${textbook}\n` : ''}
For each slide produce comprehensive, detailed, and easy-to-understand educational content that includes:
1. Clear explanations of concepts
2. Examples or illustrations where appropriate
3. Key points to emphasize
4. Any formulas or short code snippets that would be helpful

Return a JSON array, one object per slide, in the same order as the outline:
[
  {
    "slide_id": 1,
    "title": "Slide title",
    "bullets": ["3 to 6 concise bullet points, each under 20 words"],
    "code": "optional short code snippet or formula (plain text, no markdown fences) or empty string",
    "code_language": "python|latex|text or empty string",
    "notes": "2-4 sentences of teaching notes explaining the slide in depth"
  }
]
Keep each slide's content short enough to fit on a single slide. Your response must be valid JSON.`,

  script: (course, chapter, slides, prior) => `Write the spoken lecture script for the slide deck below.

${courseContext(course)}

Chapter: ${chapter.title}

Slides (JSON):
${JSON.stringify(slides.map(s => ({ slide_id: s.slide_id, title: s.title, bullets: s.bullets, code: s.code, notes: s.notes })), null, 2)}

${prior ? `Course context:\n${prior}\n` : ''}
Requirements:
- One narration entry per slide, in order, 60–140 spoken words each (about 30–60 seconds).
- Speak naturally to students, with smooth transitions between slides. Do not read bullet points verbatim; explain them.
- Explain any formula or code shown on the slide in plain words.
- No stage directions, no markdown, no bullet symbols in the narration.

Return a JSON array:
[{"slide_id": 1, "narration": "..."}]
Your response must be valid JSON.`,

  homework: (course, chapter, slides, assessmentPlan, textbook) => `Create the homework assignment for this chapter.

${courseContext(course)}

Chapter: ${chapter.title}
Description: ${chapter.description}

Slide titles and key points:
${slides.map(s => `- ${s.title}: ${(s.bullets || []).join('; ')}`).join('\n')}

${assessmentPlan ? `Course assessment plan (follow its formats, rubrics and policies):\n${assessmentPlan}\n` : ''}${textbook ? `${textbook}\n` : ''}
Write the homework in Markdown with these sections:
1. **Learning objectives assessed** (bullet list mapped to the chapter)
2. **Part A – Concept check**: 5 multiple-choice questions with options A–D
3. **Part B – Short answer**: 3 questions requiring 3–6 sentence answers
4. **Part C – Applied problem**: 1–2 problems or a small programming/analysis task with clear deliverables
5. **Submission** (format, due window relative to the week, late policy)
6. **Grading rubric** (table with criteria, points, descriptors)
7. **Answer key and model solutions** (clearly separated under a heading "Instructor only")
Be precise and self-contained; students should be able to complete it with the lecture material.`,

  lab: (course, chapter, slides, resources, textbook) => `Design a hands-on lab session for this chapter.

${courseContext(course)}

Chapter: ${chapter.title}
Description: ${chapter.description}

Slide titles and key points:
${slides.map(s => `- ${s.title}: ${(s.bullets || []).join('; ')}`).join('\n')}

${resources ? `Available resources and constraints:\n${resources}\n` : ''}${textbook ? `${textbook}\n` : ''}
Write the lab in Markdown with these sections:
1. **Lab overview** (goal, duration, individual/pair work)
2. **Learning outcomes**
3. **Prerequisites and setup** (software, data, environment; exact install or access steps)
4. **Guided tasks**: 3–5 numbered tasks, each with instructions, starter code or templates where relevant (use fenced code blocks), expected output, and a checkpoint question
5. **Challenge extension** (optional advanced task)
6. **Deliverables and submission**
7. **Grading rubric** (table)
8. **Instructor notes** (common errors, timing, solutions sketch) under a heading "Instructor only"
Make every step concrete enough that a student can follow it without the instructor.`,

  quiz: (course, chapter, slides, n, assessmentPlan, textbook) => `Create a ${n}-question quiz for this chapter.

${courseContext(course)}

Chapter: ${chapter.title}
Description: ${chapter.description}

Slide titles and key points:
${slides.map(s => `- ${s.title}: ${(s.bullets || []).join('; ')}`).join('\n')}

${assessmentPlan ? `Course assessment plan (follow its question formats and difficulty):\n${assessmentPlan}\n` : ''}${textbook ? `${textbook}\n` : ''}
Mix question types: mostly multiple choice (4 options, exactly one correct), plus 1–2 true/false and 1–2 short-answer items.
Each question must test understanding, not recall of wording; include distractors that reflect common misconceptions.

Return a JSON array:
[
  {"id": 1, "type": "multiple_choice", "question": "...", "options": ["A) ...", "B) ...", "C) ...", "D) ..."], "answer": "B", "explanation": "why B is correct and the others are not", "objective": "the learning objective assessed", "difficulty": "easy|medium|hard"},
  {"id": 2, "type": "true_false", "question": "...", "options": ["True", "False"], "answer": "True", "explanation": "...", "objective": "...", "difficulty": "easy"},
  {"id": 3, "type": "short_answer", "question": "...", "options": [], "answer": "model answer in 1–3 sentences", "explanation": "grading notes", "objective": "...", "difficulty": "medium"}
]
Your response must be valid JSON.`,

  exam: (course, exam, chapters, assessmentPlan, finalProject) => `Write the ${exam.name.toLowerCase()} for this course, covering the ${exam.scope}.

${courseContext(course)}

Chapters covered (with key points):
${chapters.map((c, i) => `${i + 1}. ${c.title}: ${c.points.join('; ') || c.description}`).join('\n')}

${assessmentPlan ? `Course assessment plan (follow its weighting, formats and academic-integrity policy):\n${assessmentPlan}\n` : ''}${exam.id === 'final' && finalProject ? `Note: the course also has a final project; the exam should complement it, not duplicate it:\n${finalProject.slice(0, 1500)}\n` : ''}
Write the exam in Markdown with these sections:
1. **Exam information** (duration, total points, allowed materials, instructions)
2. **Part A – Multiple choice** (10 questions, 2 points each; options A–D)
3. **Part B – Short answer** (5 questions, 6 points each)
4. **Part C – Problem solving / analysis** (2–3 extended problems, 15–20 points each; may include code or data analysis)
5. **Blueprint table** mapping every question to a chapter and a learning objective with its point value
6. **Answer key and rubric** under a heading "Instructor only"
Balance coverage across the chapters listed above. Questions must be answerable from the course material.`,

  beamer: (course, chapter, slides) => `Write the LaTeX Beamer frame body for each slide below.

${courseContext(course)}

Chapter: ${chapter.title}

Slides (JSON):
${JSON.stringify(slides.map(s => ({ slide_id: s.slide_id, title: s.title, bullets: s.bullets, code: s.code, code_language: s.code_language })), null, 2)}

For every slide return the LaTeX that goes INSIDE \\begin{frame}[fragile]{Title} … \\end{frame} (do not include the frame environment or the title).
Guidelines:
1. Use itemize/enumerate for the bullets; at most 3 nesting levels, prefer 2.
2. Write formulas in proper math mode (inline $…$ or equation/align*); never nest display-math environments.
3. Put code in ONE lstlisting environment per slide, inside a two-column layout when there are bullets as well (\\begin{columns}[T] with 0.55/0.45 widths).
4. The preamble is fixed: no \\usepackage, no \\definecolor; only standard colors or \\textcolor[HTML]{RRGGBB}{…}.
5. Escape special characters in prose (\\& \\% \\_ \\#); use $\\gamma$ instead of γ; keep each frame within one screen.

Return a JSON array: [{"slide_id": 1, "latex": "…"}]. Your response must be valid JSON.`,

  review: (kind, text) => `Review the following ${kind} for factual accuracy, alignment with the stated objectives, appropriate difficulty and clarity.

${text}

Return JSON: {"score": 1-10, "issues": ["specific issue", ...], "strengths": ["...", ...]}`,
};

/** Appended to a stage's user prompt when the instructor re-runs it with comments. */
export function revisionBlock(feedback, previous, kind = 'text') {
  if (!feedback) return '';
  const prev = previous ? `\n\nPrevious version (revise it; keep everything that was not criticized${kind === 'json' ? ', and return the same JSON structure' : ''}):\n${previous.slice(0, 20000)}` : '';
  return `\n\n---\nRevision request from the instructor. Apply these comments to the previous version:\n${feedback}${prev}`;
}
