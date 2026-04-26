"use client";

import { memo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { FieldError } from '@/lib/formValidation';
import { motion, AnimatePresence } from 'framer-motion';

interface ValidationErrorsProps {
  errors: FieldError[];
  className?: string;
}

const ValidationErrors = memo(function ValidationErrors({ errors, className = '' }: ValidationErrorsProps) {
  if (errors.length === 0) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        className={`overflow-hidden ${className}`}
      >
        <div className="bg-rose-500/5 border border-rose-500/20 rounded-xl p-2.5 space-y-1.5">
          {errors.map((err, i) => (
            <div key={`${err.field}-${i}`} className="flex items-start gap-2">
              <AlertTriangle size={11} className="text-rose-500 shrink-0 mt-0.5" />
              <span className="text-[9px] font-black text-rose-600 dark:text-rose-400 uppercase tracking-widest italic leading-tight">
                {err.message}
              </span>
            </div>
          ))}
        </div>
      </motion.div>
    </AnimatePresence>
  );
});

ValidationErrors.displayName = 'ValidationErrors';
export default ValidationErrors;
